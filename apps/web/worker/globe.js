import { CITIES, CITY_BY_ID } from "@omanow/core/cities.js";
import { WAVES } from "@omanow/core/waves.js";

export const MIN_PER_CITY = 3;
export const HEARTBEAT_TTL_MS = 65 * 60_000;
export const TODAY_MS = 24 * 3_600_000;
export const HISTORY_DAYS = 371;

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const PUBLISH_MS = 60_000;
const SWEEP_MS = 15 * 60_000;
const CHANGES_PER_MINUTE = 12;
const SYNCS_PER_MINUTE = 30;
const WAVES_PER_MINUTE = 10;
const ALL_WAVES_PER_MINUTE = 120;
const MAX_VIEWERS = 5000;
const CLIENT_ID = /^[A-Za-z0-9-]{16,64}$/;
const THEME_HEX = /^(?:[0-9a-f]{6}){1,32}$/;

const minuteOf = (ms) => Math.floor(ms / 60_000);
const dayOf = (minute) => Math.floor(minute / 1440);
const isoDay = (day) => new Date(day * DAY_MS).toISOString().slice(0, 10);
const liveSince = (minute) => minute - HEARTBEAT_TTL_MS / 60_000;
const NO_SNAPSHOT = { cities: [], counts: [], named: [] };

export function json(status, data, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff", ...headers },
  });
}

function publicHeat(live, min = MIN_PER_CITY, snapshot = NO_SNAPSHOT, waves = []) {
  const cities = [...live].filter(([, n]) => n >= min).sort(([a], [b]) => a.localeCompare(b));
  const named = new Set(cities.map(([city]) => city));
  const quiet = snapshot.counts.filter(([city]) => !named.has(city));
  const total = [...cities, ...quiet].reduce((sum, [, n]) => sum + n, 0);
  const today = new Set([...snapshot.cities, ...snapshot.named, ...named]);
  return { total, cities, min, today: [...today].sort(), waves: waves.filter(([city]) => today.has(city)) };
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
    this.slowMs = Number(env.SLOW_SECONDS) * 1000 || HOUR_MS;
    this.min = Number(env.MIN_PER_CITY) || MIN_PER_CITY;
    this.changes = createLimiter(CHANGES_PER_MINUTE);
    this.syncs = createLimiter(SYNCS_PER_MINUTE);
    this.waves = createLimiter(WAVES_PER_MINUTE);
    this.allWaves = createLimiter(ALL_WAVES_PER_MINUTE);
    this.fake = env.DEMO === "1" ? seedDemo() : null;

    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS presence (key TEXT PRIMARY KEY, city TEXT NOT NULL, seen INTEGER NOT NULL, since INTEGER NOT NULL DEFAULT 0) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS daily (day INTEGER PRIMARY KEY, n INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS waves (hour INTEGER NOT NULL, city TEXT NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (hour, city)) WITHOUT ROWID;
      DROP TABLE IF EXISTS online;
    `);
    if (!this.sql.exec("PRAGMA table_info(presence)").toArray().some((c) => c.name === "since")) {
      this.sql.exec("ALTER TABLE presence ADD COLUMN since INTEGER NOT NULL DEFAULT 0");
    }
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    if (this.fake) ctx.blockConcurrencyWhile(() => this.schedule(this.publishMs));
  }

  async fetch(request) {
    const { pathname } = new URL(request.url);
    const ip = request.headers.get("cf-connecting-ip") || "unknown";
    if (request.method === "GET" && pathname === "/api/heat") return json(200, await this.published());
    if (request.method === "GET" && pathname === "/api/history") return json(200, this.history(), { "cache-control": "public, max-age=600" });
    if (request.method === "GET" && pathname === "/api/live") return this.live(request);
    if (request.method === "POST" && pathname === "/api/online") return this.online(request, ip);
    if (request.method === "POST" && pathname === "/api/offline") return this.offline(request);
    if (request.method === "POST" && pathname === "/api/wave") return this.wave(request, ip);
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

  async online(request, ip) {
    const body = await readBody(request);
    if (typeof body?.id !== "string" || !CLIENT_ID.test(body.id)) return json(400, { error: "invalid id" });
    if (!CITY_BY_ID.has(body.city)) return json(400, { error: "unknown city" });
    const key = await hashId(body.id);
    // Minute precision is all expiry needs, and all that's kept.
    const minute = minuteOf(Date.now());
    const prev = this.sql.exec("SELECT city, seen FROM presence WHERE key = ?", key).toArray()[0];

    if (prev?.city === body.city && prev.seen >= liveSince(minute)) {
      if (prev.seen !== minute) this.sql.exec("UPDATE presence SET seen = ? WHERE key = ?", minute, key);
      await this.schedule(this.untilSweep());
    } else {
      if (this.changes(ip)) return slowDown();
      if (prev?.city === body.city) this.sql.exec("UPDATE presence SET seen = ? WHERE key = ?", minute, key);
      else this.sql.exec("INSERT OR REPLACE INTO presence (key, city, seen, since) VALUES (?, ?, ?, ?)", key, body.city, minute, minute);
      await this.schedule(this.publishMs);
    }
    if (!prev || dayOf(prev.seen) !== dayOf(minute)) {
      this.sql.exec("INSERT INTO daily (day, n) VALUES (?, 1) ON CONFLICT (day) DO UPDATE SET n = n + 1", dayOf(minute));
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
      await this.schedule(this.publishMs);
    }
    return json(200, { online: null });
  }

  async wave(request, ip) {
    const body = await readBody(request);
    if (!WAVES.has(body?.kind)) return json(400, { error: "unknown wave" });
    if (!((await this.published()).today || []).includes(body.city)) return json(400, { error: "city not on the map" });
    if (this.waves(ip) || this.allWaves("all")) return slowDown();
    this.sql.exec("INSERT INTO waves (hour, city, n) VALUES (?, ?, 1) ON CONFLICT (hour, city) DO UPDATE SET n = n + 1", Math.floor(Date.now() / HOUR_MS), body.city);
    this.broadcast({ type: "wave", city: body.city, kind: body.kind });
    await this.schedule(this.publishMs);
    return json(200, { ok: true });
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
    this.broadcast({ type: "sync", theme, me }, `sync:${body.sync}`);
    return json(200, { ok: true });
  }

  history() {
    const today = dayOf(minuteOf(Date.now()));
    const since = today - HISTORY_DAYS;
    const counts = new Map(this.fake?.days);
    for (const { day, n } of this.sql.exec("SELECT day, n FROM daily WHERE day > ? AND day < ?", since, today)) counts.set(day, (counts.get(day) || 0) + n);
    const days = [...counts]
      .filter(([day]) => day > since && day < today)
      .sort(([a], [b]) => a - b)
      .map(([day, n]) => [isoDay(day), n]);
    return { days };
  }

  broadcast(data, tag) {
    const message = JSON.stringify(data);
    for (const ws of this.ctx.getWebSockets(tag)) {
      try {
        ws.send(message);
      } catch {}
    }
  }

  async schedule(ms) {
    const at = Date.now() + ms;
    const current = await this.ctx.storage.getAlarm();
    if (current == null || current > at) await this.ctx.storage.setAlarm(at);
  }

  untilSweep(now = Date.now()) {
    return Math.min(SWEEP_MS, (Math.floor(now / this.slowMs) + 1) * this.slowMs - now);
  }

  async published() {
    return (await this.ctx.storage.get("published")) || publicHeat(new Map(), this.min);
  }

  async snapshot(now) {
    const slot = Math.floor(now / this.slowMs);
    const stored = await this.ctx.storage.get("snapshot");
    if (stored?.slot === slot) return stored;
    const at = minuteOf(slot * this.slowMs);
    const cities = new Set(this.fake?.today);
    const counts = new Map(this.fake?.live);
    const rows = this.sql.exec(
      "SELECT city, sum(seen >= ?) AS n FROM presence WHERE since < ? AND seen >= ? GROUP BY city",
      liveSince(at),
      at,
      minuteOf(slot * this.slowMs - TODAY_MS),
    );
    for (const { city, n } of rows) {
      cities.add(city);
      if (n) counts.set(city, (counts.get(city) || 0) + n);
    }
    const snapshot = { slot, cities: [...cities], counts: [...counts], named: [] };
    await this.ctx.storage.put("snapshot", snapshot);
    return snapshot;
  }

  // Publishing only on this timer batches changes, so a change on the map
  // can't be pinned to the moment one machine joined.
  async alarm() {
    const now = Date.now();
    const minute = minuteOf(now);
    this.sql.exec("DELETE FROM presence WHERE seen < ?", minuteOf(now - TODAY_MS));
    this.sql.exec("DELETE FROM daily WHERE day <= ?", dayOf(minute) - HISTORY_DAYS);
    this.sql.exec("DELETE FROM waves WHERE hour <= ?", Math.floor(now / HOUR_MS) - 24);
    if (this.fake) stepDemo(this.fake);

    const live = new Map(this.fake?.live);
    for (const { city, n } of this.sql.exec("SELECT city, count(*) AS n FROM presence WHERE seen >= ? GROUP BY city", liveSince(minute))) {
      live.set(city, (live.get(city) || 0) + n);
    }
    const snapshot = await this.snapshot(now);
    const waves = this.sql.exec("SELECT city, sum(n) AS n FROM waves GROUP BY city ORDER BY city").toArray().map(({ city, n }) => [city, n]);
    const heat = publicHeat(live, this.min, snapshot, waves);
    const named = heat.cities.map(([city]) => city).filter((city) => !snapshot.named.includes(city));
    if (named.length) await this.ctx.storage.put("snapshot", { ...snapshot, named: [...snapshot.named, ...named] });
    const joins = joinsBetween(await this.published(), heat);
    await this.ctx.storage.put("published", heat);
    this.broadcast({ type: "heat", ...heat, joins });
    const wave = this.fake && demoWave(heat);
    if (wave) this.broadcast(wave);

    if (this.fake) await this.schedule(this.publishMs);
    else if (heat.today.length || this.sql.exec("SELECT 1 FROM presence UNION ALL SELECT 1 FROM waves LIMIT 1").toArray().length) {
      await this.schedule(this.untilSweep(now));
    }
  }
}

// Synthetic crowd for `pnpm demo`: seeded counts plus a trickle of machines
// coming and going. Memory only, never stored.
function seedDemo() {
  const live = new Map();
  for (const c of CITIES) {
    if (Math.random() < 0.8) live.set(c.id, Math.max(1, Math.round(c.weight ** 2.1 * (0.4 + Math.random()))));
  }
  const today = new Set(live.keys());
  for (const c of CITIES) if (Math.random() < 0.5) today.add(c.id);
  const total = [...live.values()].reduce((sum, n) => sum + n, 0);
  const days = new Map();
  const day = dayOf(minuteOf(Date.now()));
  for (let i = 1; i <= 300; i++) {
    const weekend = [0, 6].includes(new Date((day - i) * DAY_MS).getUTCDay()) ? 0.75 : 1;
    days.set(day - i, Math.max(1, Math.round(total * 1.5 * (1 - i / 300) ** 1.4 * weekend * (0.85 + Math.random() * 0.3))));
  }
  return { live, today, days };
}

const DEMO_WEIGHTED = CITIES.flatMap((c) => Array(c.weight * c.weight).fill(c.id));

function stepDemo({ live }) {
  for (let i = Math.floor(Math.random() * 4); i > 0; i--) {
    const city = DEMO_WEIGHTED[Math.floor(Math.random() * DEMO_WEIGHTED.length)];
    const n = live.get(city) || 0;
    live.set(city, Math.random() < 0.15 && n > 1 ? n - 1 : n + 1);
  }
}

function demoWave({ today }) {
  if (Math.random() < 0.5 || !today.length) return null;
  const kinds = [...WAVES.keys()];
  return { type: "wave", city: today[Math.floor(Math.random() * today.length)], kind: kinds[Math.floor(Math.random() * kinds.length)] };
}
