import { CITIES, CITY_BY_ID } from "@omaglobe/core/cities.js";

export const MIN_PER_CITY = 3;
export const HEARTBEAT_TTL_MS = 65 * 60_000;

const PUBLISH_MS = 60_000;
const SWEEP_MS = 15 * 60_000;
const CHANGES_PER_MINUTE = 12;
const SYNCS_PER_MINUTE = 30;
const MAX_VIEWERS = 5000;
const CLIENT_ID = /^[A-Za-z0-9-]{16,64}$/;
const THEME_HEX = /^(?:[0-9a-f]{6}){1,32}$/;

export function json(status, data, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff", ...headers },
  });
}

function publicHeat(counts, min = MIN_PER_CITY) {
  const cities = [...counts].filter(([, n]) => n >= min).sort(([a], [b]) => a.localeCompare(b));
  return { total: cities.reduce((sum, [, n]) => sum + n, 0), cities, min };
}

function joinsBetween(prev, next) {
  const before = new Map(prev?.cities || []);
  return next.cities.filter(([city, n]) => n > (before.get(city) || 0)).map(([city]) => city);
}

const hashId = async (id) => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(id));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
};

function createLimiter(perMinute) {
  let window = 0;
  let byIp = new Map();
  return (ip) => {
    const now = Math.floor(Date.now() / 60_000);
    if (now !== window) [window, byIp] = [now, new Map()];
    const n = (byIp.get(ip) || 0) + 1;
    byIp.set(ip, n);
    return n > perMinute;
  };
}

const slowDown = () => json(429, { error: "slow down" }, { "retry-after": "60" });

async function readBody(request) {
  const text = await request.text();
  if (text.length > 1024) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export class Globe {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.sql = ctx.storage.sql;
    this.publishMs = Number(env.PUBLISH_SECONDS) * 1000 || PUBLISH_MS;
    this.min = Number(env.MIN_PER_CITY) || MIN_PER_CITY;
    this.changes = createLimiter(CHANGES_PER_MINUTE);
    this.syncs = createLimiter(SYNCS_PER_MINUTE);
    this.fake = env.DEMO === "1" ? seedDemo() : null;

    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS presence (key TEXT PRIMARY KEY, city TEXT NOT NULL, seen INTEGER NOT NULL) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS online (city TEXT PRIMARY KEY, n INTEGER NOT NULL);
    `);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    if (this.fake) ctx.blockConcurrencyWhile(() => this.schedule(this.publishMs));
  }

  async fetch(request) {
    const { pathname } = new URL(request.url);
    const ip = request.headers.get("cf-connecting-ip") || "unknown";
    if (request.method === "GET" && pathname === "/api/heat") return json(200, await this.published());
    if (request.method === "GET" && pathname === "/api/live") return this.live(request);
    if (request.method === "POST" && pathname === "/api/online") return this.online(request, ip);
    if (request.method === "POST" && pathname === "/api/offline") return this.offline(request);
    if (request.method === "POST" && pathname === "/api/sync") return this.forwardToPluginPage(request, ip);
    return json(404, { error: "not found" });
  }

  async live(request) {
    if (request.headers.get("upgrade") !== "websocket") return json(426, { error: "expected websocket" });
    if (this.ctx.getWebSockets().length >= MAX_VIEWERS) return json(503, { error: "too many viewers" });
    const [client, server] = Object.values(new WebSocketPair());
    const sync = new URL(request.url).searchParams.get("sync");
    this.ctx.acceptWebSocket(server, sync && CLIENT_ID.test(sync) ? [`sync:${sync}`] : []);
    server.send(JSON.stringify({ type: "heat", ...(await this.published()), joins: [] }));
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage() {}

  // Unchanged heartbeats aren't limited: they rewrite at most one row a
  // minute. Only new machines and city moves are.
  async online(request, ip) {
    const body = await readBody(request);
    if (typeof body?.id !== "string" || !CLIENT_ID.test(body.id)) return json(400, { error: "invalid id" });
    if (!CITY_BY_ID.has(body.city)) return json(400, { error: "unknown city" });
    const key = await hashId(body.id);
    // Minute precision is all expiry needs, and all that's kept.
    const minute = Math.floor(Date.now() / 60_000);
    const prev = this.sql.exec("SELECT city, seen FROM presence WHERE key = ?", key).toArray()[0];

    if (prev?.city === body.city) {
      if (prev.seen !== minute) this.sql.exec("UPDATE presence SET seen = ? WHERE key = ?", minute, key);
      await this.schedule(SWEEP_MS);
    } else {
      if (this.changes(ip)) return slowDown();
      if (prev) this.adjust(prev.city, -1);
      this.sql.exec("INSERT OR REPLACE INTO presence (key, city, seen) VALUES (?, ?, ?)", key, body.city, minute);
      this.adjust(body.city, 1);
      await this.schedule(this.publishMs);
    }
    return json(200, { online: body.city, heat: await this.published() });
  }

  // Never limited: switching off must always work.
  async offline(request) {
    const body = await readBody(request);
    if (typeof body?.id !== "string" || !CLIENT_ID.test(body.id)) return json(400, { error: "invalid id" });
    const key = await hashId(body.id);
    const prev = this.sql.exec("SELECT city FROM presence WHERE key = ?", key).toArray()[0];
    if (prev) {
      this.sql.exec("DELETE FROM presence WHERE key = ?", key);
      this.adjust(prev.city, -1);
      await this.schedule(this.publishMs);
    }
    return json(200, { online: null });
  }

  async forwardToPluginPage(request, ip) {
    if (this.syncs(ip)) return slowDown();
    const body = await readBody(request);
    const theme = body?.theme;
    const me = body?.me;
    const validTheme = theme === undefined || (typeof theme === "string" && THEME_HEX.test(theme));
    const validMe = me === undefined || me === "" || CITY_BY_ID.has(me);
    if (typeof body?.sync !== "string" || !CLIENT_ID.test(body.sync) || !validTheme || !validMe || (theme === undefined && me === undefined)) {
      return json(400, { error: "invalid sync" });
    }
    const message = JSON.stringify({ type: "sync", theme, me });
    for (const ws of this.ctx.getWebSockets(`sync:${body.sync}`)) {
      try {
        ws.send(message);
      } catch {
        // Already closed; the page reconnects.
      }
    }
    return json(200, { ok: true });
  }

  adjust(city, by) {
    this.sql.exec("INSERT INTO online (city, n) VALUES (?, ?) ON CONFLICT (city) DO UPDATE SET n = n + excluded.n", city, by);
    this.sql.exec("DELETE FROM online WHERE city = ? AND n <= 0", city);
  }

  async schedule(ms) {
    const at = Date.now() + ms;
    const current = await this.ctx.storage.getAlarm();
    if (current == null || current > at) await this.ctx.storage.setAlarm(at);
  }

  async published() {
    return (await this.ctx.storage.get("published")) || publicHeat(new Map(), this.min);
  }

  // Publishing only on this timer batches changes, so a change on the map
  // can't be pinned to the moment one machine joined.
  async alarm() {
    const cutoff = Math.floor((Date.now() - HEARTBEAT_TTL_MS) / 60_000);
    const stale = this.sql.exec("SELECT city, count(*) AS n FROM presence WHERE seen < ? GROUP BY city", cutoff).toArray();
    if (stale.length) {
      this.sql.exec("DELETE FROM presence WHERE seen < ?", cutoff);
      for (const { city, n } of stale) this.adjust(city, -n);
    }
    if (this.fake) stepDemo(this.fake);

    const counts = new Map(this.fake);
    for (const { city, n } of this.sql.exec("SELECT city, n FROM online")) counts.set(city, (counts.get(city) || 0) + n);
    const heat = publicHeat(counts, this.min);
    const joins = joinsBetween(await this.published(), heat);
    await this.ctx.storage.put("published", heat);
    const message = JSON.stringify({ type: "heat", ...heat, joins });
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(message);
      } catch {
        // Already closed; the page reconnects.
      }
    }

    if (this.fake) await this.schedule(this.publishMs);
    else if (this.sql.exec("SELECT 1 FROM presence LIMIT 1").toArray().length) await this.schedule(SWEEP_MS);
  }
}

// Synthetic crowd for `pnpm demo`: seeded counts plus a trickle of machines
// coming and going. Memory only, never stored.
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
