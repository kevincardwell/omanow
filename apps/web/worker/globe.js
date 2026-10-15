// The one Durable Object behind the globe: opt-ins and plugin presence in
// SQLite, aggregate heat published on a timer, pushed to viewers over
// hibernating WebSockets.

import { CITIES, CITY_BY_ID } from "@omaglobe/core/cities.js";

/** A city appears on the public map only once this many people share it. */
export const MIN_PEOPLE = 3;
/** Opt-ins not re-affirmed by a visit within this many days are dropped. */
export const RETENTION_DAYS = 180;
/** A plugin counts as online this long after its last heartbeat. */
export const ONLINE_MS = 65 * 60_000;

const PUBLISH_MS = 60_000;
const SWEEP_MS = 15 * 60_000;
const DAY_MS = 86_400_000;
const WRITES_PER_MINUTE = 6;
const MAX_VIEWERS = 5000;
const CLIENT_ID = /^[A-Za-z0-9-]{16,64}$/;
const THEME_HEX = /^(?:[0-9a-f]{6}){1,32}$/;

export function json(status, data, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff", ...headers },
  });
}

const visible = (counts) => [...counts].filter(([, n]) => n >= MIN_PEOPLE).sort(([a], [b]) => a.localeCompare(b));
const sum = (cities) => cities.reduce((total, [, n]) => total + n, 0);

/** Aggregate counts as the public sees them: small cities withheld. A city's
 *  heat is its web opt-ins plus plugins online there. */
export function publicHeat(shared, online = new Map()) {
  const all = new Map(shared);
  for (const [city, n] of online) all.set(city, (all.get(city) || 0) + n);
  const cities = visible(all);
  const onlineCities = visible(online);
  return { total: sum(cities), cities, online: sum(onlineCities), onlineCities, min: MIN_PEOPLE };
}

export function joinsBetween(prev, next) {
  const before = new Map(prev?.cities || []);
  return next.cities.filter(([city, n]) => n > (before.get(city) || 0)).map(([city]) => city);
}

const hashId = async (id) => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(id));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
};

const WRITE_PATHS = new Set(["/api/share", "/api/unshare", "/api/online", "/api/offline"]);

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
      CREATE TABLE IF NOT EXISTS presence (key TEXT PRIMARY KEY, city TEXT NOT NULL, seen INTEGER NOT NULL) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS online (city TEXT PRIMARY KEY, n INTEGER NOT NULL);
    `);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    if (this.fake) ctx.blockConcurrencyWhile(() => this.schedule(this.publishMs));
  }

  async fetch(request) {
    const { pathname } = new URL(request.url);
    if (request.method === "GET" && pathname === "/api/heat") return json(200, await this.published());
    if (request.method === "GET" && pathname === "/api/live") return this.live(request);
    if (request.method === "POST" && pathname === "/api/sync") return this.relay(request);
    if (request.method === "POST" && WRITE_PATHS.has(pathname)) return this.write(request, pathname);
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

  // The plugin's theme switches and on/off changes, passed to the page it
  // opened. Relayed to that page's socket and never stored.
  async relay(request) {
    if (this.limited(request.headers.get("cf-connecting-ip") || "unknown")) return json(429, { error: "slow down" }, { "retry-after": "60" });
    const text = await request.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      return json(400, { error: "invalid body" });
    }
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
        // Gone; the page will reconnect with the same sync id.
      }
    }
    return json(200, { ok: true });
  }

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
    const stopping = pathname === "/api/unshare" || pathname === "/api/offline";
    if (!stopping && this.limited(request.headers.get("cf-connecting-ip") || "unknown")) {
      return json(429, { error: "slow down" }, { "retry-after": "60" });
    }
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      return json(400, { error: "invalid body" });
    }
    if (typeof body?.id !== "string" || !CLIENT_ID.test(body.id)) return json(400, { error: "invalid id" });
    if (!stopping && !CITY_BY_ID.has(body.city)) return json(400, { error: "unknown city" });
    const key = await hashId(body.id);

    if (pathname === "/api/unshare") {
      if (this.remove("optins", "counts", key)) await this.schedule(this.publishMs);
      return json(200, { sharing: null });
    }
    if (pathname === "/api/offline") {
      if (this.remove("presence", "online", key)) await this.schedule(this.publishMs);
      return json(200, { online: null });
    }
    if (pathname === "/api/online") {
      // Minutes are enough to expire presence and say nothing more precise.
      const changed = this.upsert("presence", "online", "seen", key, body.city, Math.floor(Date.now() / 60_000));
      await this.schedule(changed ? this.publishMs : SWEEP_MS);
      return json(200, { online: body.city, heat: await this.published() });
    }
    if (this.upsert("optins", "counts", "day", key, body.city, Math.floor(Date.now() / DAY_MS))) await this.schedule(this.publishMs);
    return json(200, { sharing: body.city });
  }

  // Records key -> city, keeping the per-city counts in step. Returns whether
  // the public counts changed.
  upsert(table, counts, column, key, city, at) {
    const prev = this.sql.exec(`SELECT city, ${column} AS at FROM ${table} WHERE key = ?`, key).toArray()[0];
    if (prev?.city === city) {
      if (prev.at !== at) this.sql.exec(`UPDATE ${table} SET ${column} = ? WHERE key = ?`, at, key);
      return false;
    }
    if (prev) this.adjust(counts, prev.city, -1);
    this.sql.exec(`INSERT OR REPLACE INTO ${table} (key, city, ${column}) VALUES (?, ?, ?)`, key, city, at);
    this.adjust(counts, city, 1);
    return true;
  }

  remove(table, counts, key) {
    const prev = this.sql.exec(`SELECT city FROM ${table} WHERE key = ?`, key).toArray()[0];
    if (!prev) return false;
    this.sql.exec(`DELETE FROM ${table} WHERE key = ?`, key);
    this.adjust(counts, prev.city, -1);
    return true;
  }

  adjust(counts, city, by) {
    this.sql.exec(`INSERT INTO ${counts} (city, n) VALUES (?, ?) ON CONFLICT (city) DO UPDATE SET n = n + excluded.n`, city, by);
    this.sql.exec(`DELETE FROM ${counts} WHERE city = ? AND n <= 0`, city);
  }

  async schedule(ms) {
    const at = Date.now() + ms;
    const current = await this.ctx.storage.getAlarm();
    if (current == null || current > at) await this.ctx.storage.setAlarm(at);
  }

  async published() {
    return (await this.ctx.storage.get("published")) || publicHeat(new Map());
  }

  counts(table) {
    const out = new Map();
    for (const { city, n } of this.sql.exec(`SELECT city, n FROM ${table}`)) out.set(city, n);
    return out;
  }

  // Publishing only on this timer, never per request, batches joins so a
  // change on the map can't be pinned to the moment one person shared.
  async alarm() {
    this.expire("optins", "counts", "day", Math.floor(Date.now() / DAY_MS) - RETENTION_DAYS);
    this.expire("presence", "online", "seen", Math.floor((Date.now() - ONLINE_MS) / 60_000));
    if (this.fake) stepDemo(this.fake);

    const shared = this.counts("counts");
    const online = this.counts("online");
    if (this.fake) {
      for (const [city, n] of this.fake.shared) shared.set(city, (shared.get(city) || 0) + n);
      for (const [city, n] of this.fake.online) online.set(city, (online.get(city) || 0) + n);
    }
    const heat = publicHeat(shared, online);
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
    else if (this.sql.exec("SELECT 1 FROM presence LIMIT 1").toArray().length) await this.schedule(SWEEP_MS);
    else if (this.sql.exec("SELECT 1 FROM optins LIMIT 1").toArray().length) await this.schedule(DAY_MS);
  }

  expire(table, counts, column, cutoff) {
    const stale = this.sql.exec(`SELECT city, count(*) AS n FROM ${table} WHERE ${column} < ? GROUP BY city`, cutoff).toArray();
    if (!stale.length) return;
    this.sql.exec(`DELETE FROM ${table} WHERE ${column} < ?`, cutoff);
    for (const { city, n } of stale) this.adjust(counts, city, -n);
  }
}

// Synthetic crowd for `pnpm demo`: seeded counts plus a trickle of joins and
// the odd leave, with a slice of each city "online". Memory only, never stored.
function seedDemo() {
  const shared = new Map();
  const online = new Map();
  for (const c of CITIES) {
    if (Math.random() < 0.8) shared.set(c.id, Math.max(1, Math.round(c.weight ** 2.1 * (0.4 + Math.random()))));
    if (Math.random() < 0.4) online.set(c.id, Math.round(c.weight ** 1.6 * Math.random()));
  }
  return { shared, online };
}

const DEMO_WEIGHTED = CITIES.flatMap((c) => Array(c.weight * c.weight).fill(c.id));

function stepDemo({ shared, online }) {
  for (let i = Math.floor(Math.random() * 4); i > 0; i--) {
    const city = DEMO_WEIGHTED[Math.floor(Math.random() * DEMO_WEIGHTED.length)];
    const counts = Math.random() < 0.3 ? online : shared;
    const n = counts.get(city) || 0;
    counts.set(city, Math.random() < 0.15 && n > 1 ? n - 1 : n + 1);
  }
}
