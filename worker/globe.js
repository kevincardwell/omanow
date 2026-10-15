// The one Durable Object behind the globe: opt-ins in SQLite, aggregate heat
// published on a timer, pushed to viewers over hibernating WebSockets.

import { CITIES, CITY_BY_ID } from "../src/core/cities.js";

/** A city appears on the public map only once this many people share it. */
export const MIN_PEOPLE = 3;
/** Opt-ins not re-affirmed by a visit within this many days are dropped. */
export const RETENTION_DAYS = 180;

const PUBLISH_MS = 60_000;
const DAY_MS = 86_400_000;
const WRITES_PER_MINUTE = 6;
const MAX_VIEWERS = 5000;
const CLIENT_ID = /^[A-Za-z0-9-]{16,64}$/;

export function json(status, data, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff", ...headers },
  });
}

/** Aggregate counts as the public sees them: small cities withheld. */
export function publicHeat(counts) {
  const cities = [...counts].filter(([, n]) => n >= MIN_PEOPLE).sort(([a], [b]) => a.localeCompare(b));
  return { total: cities.reduce((sum, [, n]) => sum + n, 0), cities, min: MIN_PEOPLE };
}

export function joinsBetween(prev, next) {
  const before = new Map(prev?.cities || []);
  return next.cities.filter(([city, n]) => n > (before.get(city) || 0)).map(([city]) => city);
}

const hashId = async (id) => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(id));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
};

export class Globe {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.sql = ctx.storage.sql;
    this.publishMs = Number(env.PUBLISH_SECONDS) * 1000 || PUBLISH_MS;
    this.writes = { window: 0, byIp: new Map() }; // memory only, never stored
    this.fake = env.DEMO === "1" ? seedDemo() : null;

    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS optins (key TEXT PRIMARY KEY, city TEXT NOT NULL, day INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS optins_day ON optins (day);
      CREATE TABLE IF NOT EXISTS counts (city TEXT PRIMARY KEY, n INTEGER NOT NULL);
    `);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    if (this.fake) ctx.blockConcurrencyWhile(() => this.schedule(this.publishMs));
  }

  async fetch(request) {
    const { pathname } = new URL(request.url);
    if (request.method === "GET" && pathname === "/api/heat") return json(200, await this.published());
    if (request.method === "GET" && pathname === "/api/live") return this.live(request);
    if (request.method === "POST" && (pathname === "/api/share" || pathname === "/api/unshare")) return this.write(request, pathname);
    return json(404, { error: "not found" });
  }

  async live(request) {
    if (request.headers.get("upgrade") !== "websocket") return json(426, { error: "expected websocket" });
    if (this.ctx.getWebSockets().length >= MAX_VIEWERS) return json(503, { error: "too many viewers" });
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    server.send(JSON.stringify({ type: "heat", ...(await this.published()), joins: [] }));
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage() {}

  limited(ip) {
    const window = Math.floor(Date.now() / 60_000);
    if (window !== this.writes.window) this.writes = { window, byIp: new Map() };
    const n = (this.writes.byIp.get(ip) || 0) + 1;
    this.writes.byIp.set(ip, n);
    return n > WRITES_PER_MINUTE;
  }

  async write(request, pathname) {
    const text = await request.text();
    if (text.length > 1024) return json(413, { error: "too large" });
    // Stopping is never limited: it only deletes, and must always work.
    if (pathname === "/api/share" && this.limited(request.headers.get("cf-connecting-ip") || "unknown")) {
      return json(429, { error: "slow down" }, { "retry-after": "60" });
    }
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      return json(400, { error: "invalid body" });
    }
    if (typeof body?.id !== "string" || !CLIENT_ID.test(body.id)) return json(400, { error: "invalid id" });
    const key = await hashId(body.id);

    if (pathname === "/api/unshare") {
      const prev = this.sql.exec("SELECT city FROM optins WHERE key = ?", key).toArray()[0];
      if (prev) {
        this.sql.exec("DELETE FROM optins WHERE key = ?", key);
        this.adjust(prev.city, -1);
        await this.schedule(this.publishMs);
      }
      return json(200, { sharing: null });
    }

    if (!CITY_BY_ID.has(body.city)) return json(400, { error: "unknown city" });
    const day = Math.floor(Date.now() / DAY_MS);
    const prev = this.sql.exec("SELECT city, day FROM optins WHERE key = ?", key).toArray()[0];
    if (prev?.city === body.city) {
      if (prev.day !== day) this.sql.exec("UPDATE optins SET day = ? WHERE key = ?", day, key);
      return json(200, { sharing: body.city });
    }
    if (prev) this.adjust(prev.city, -1);
    this.sql.exec("INSERT OR REPLACE INTO optins (key, city, day) VALUES (?, ?, ?)", key, body.city, day);
    this.adjust(body.city, 1);
    await this.schedule(this.publishMs);
    return json(200, { sharing: body.city });
  }

  adjust(city, by) {
    this.sql.exec("INSERT INTO counts (city, n) VALUES (?, ?) ON CONFLICT (city) DO UPDATE SET n = n + excluded.n", city, by);
    this.sql.exec("DELETE FROM counts WHERE city = ? AND n <= 0", city);
  }

  async schedule(ms) {
    const at = Date.now() + ms;
    const current = await this.ctx.storage.getAlarm();
    if (current == null || current > at) await this.ctx.storage.setAlarm(at);
  }

  async published() {
    return (await this.ctx.storage.get("published")) || publicHeat(new Map());
  }

  // Publishing only on this timer, never per request, batches joins so a
  // change on the map can't be pinned to the moment one person shared.
  async alarm() {
    this.expire();
    if (this.fake) stepDemo(this.fake);
    const counts = new Map(this.fake);
    for (const { city, n } of this.sql.exec("SELECT city, n FROM counts")) counts.set(city, (counts.get(city) || 0) + n);
    const heat = publicHeat(counts);
    const joins = joinsBetween(await this.published(), heat);
    await this.ctx.storage.put("published", heat);
    const message = JSON.stringify({ type: "heat", ...heat, joins });
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(message);
      } catch {
        // Closing sockets are skipped; they reconnect and get a fresh snapshot.
      }
    }
    if (this.fake) await this.schedule(this.publishMs);
    else if (this.sql.exec("SELECT 1 FROM optins LIMIT 1").toArray().length) await this.schedule(DAY_MS);
  }

  expire() {
    const cutoff = Math.floor(Date.now() / DAY_MS) - RETENTION_DAYS;
    const stale = this.sql.exec("SELECT city, count(*) AS n FROM optins WHERE day < ? GROUP BY city", cutoff).toArray();
    if (!stale.length) return;
    this.sql.exec("DELETE FROM optins WHERE day < ?", cutoff);
    for (const { city, n } of stale) this.adjust(city, -n);
  }
}

// Synthetic crowd for `npm run demo`: seeded counts plus a trickle of joins
// and the odd leave. Lives in memory only and is never stored.
function seedDemo() {
  const fake = new Map();
  for (const c of CITIES) {
    if (Math.random() < 0.8) fake.set(c.id, Math.max(1, Math.round(c.weight ** 2.1 * (0.4 + Math.random()))));
  }
  return fake;
}

const DEMO_WEIGHTED = CITIES.flatMap((c) => Array(c.weight * c.weight).fill(c.id));

function stepDemo(fake) {
  for (let i = Math.floor(Math.random() * 4); i > 0; i--) {
    const city = DEMO_WEIGHTED[Math.floor(Math.random() * DEMO_WEIGHTED.length)];
    const n = fake.get(city) || 0;
    fake.set(city, Math.random() < 0.15 && n > 1 ? n - 1 : n + 1);
  }
}
