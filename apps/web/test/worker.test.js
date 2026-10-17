import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, mock, test } from "node:test";
import { Globe, HEARTBEAT_TTL_MS, HISTORY_DAYS, MIN_PER_CITY, TODAY_MS } from "../worker/globe.js";
import worker from "../worker/index.js";

globalThis.WebSocketRequestResponsePair ??= class {};

// The parts of DurableObjectState the Globe uses, on node:sqlite.
function fakeCtx() {
  const db = new DatabaseSync(":memory:");
  const kv = new Map();
  const sockets = [];
  let alarm = null;
  const cursor = (rows) => ({ toArray: () => rows, [Symbol.iterator]: () => rows[Symbol.iterator]() });
  return {
    db,
    sockets,
    storage: {
      sql: {
        exec(query, ...bindings) {
          if (!bindings.length && query.split(";").filter((s) => s.trim()).length > 1) {
            db.exec(query);
            return cursor([]);
          }
          return cursor(db.prepare(query).all(...bindings).map((row) => ({ ...row })));
        },
      },
      get: async (k) => structuredClone(kv.get(k)),
      put: async (k, v) => kv.set(k, structuredClone(v)),
      getAlarm: async () => alarm,
      setAlarm: async (at) => (alarm = at),
    },
    // The runtime clears a fired alarm before running the handler.
    fireAlarm(globe) {
      alarm = null;
      return globe.alarm();
    },
    getWebSockets: () => sockets,
    setWebSocketAutoResponse() {},
    blockConcurrencyWhile: (fn) => fn(),
  };
}

const NOW = Date.parse("2026-10-15T12:00:00Z");
let ctx;
let globe;
let env;
let ipCounter = 0;

beforeEach(() => {
  mock.timers.enable({ apis: ["Date"], now: NOW });
  ctx = fakeCtx();
  globe = new Globe(ctx, {});
  env = { GLOBE: { idFromName: () => "globe", get: () => globe } };
});
afterEach(() => mock.timers.reset());

const call = (path, { body, ip = `10.0.0.${++ipCounter}`, headers = {} } = {}) =>
  worker.fetch(
    new Request(`https://omanow.test${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { "content-type": "application/json", origin: "https://omanow.test", "cf-connecting-ip": ip, ...headers },
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    }),
    env,
  );
const heat = () => call("/api/heat").then((r) => r.json());
const online = (id, city, ip) => call("/api/online", { body: { id, city }, ip });
const machine = (n) => `machine-${String(n).padStart(12, "0")}`;
const empty = { total: 0, cities: [], min: MIN_PER_CITY, today: [], waves: [] };
const HOUR = 3_600_000;
const viewer = () => {
  const ws = { sent: [], send: (m) => ws.sent.push(JSON.parse(m)) };
  ctx.sockets.push(ws);
  return ws;
};

test("heat is published on the timer, not per request", async () => {
  for (const n of [1, 2, 3]) await online(machine(n), "berlin-de");
  assert.deepEqual(await heat(), empty);
  assert.ok((await ctx.storage.getAlarm()) > NOW, "a publish is scheduled");

  const page = viewer();
  await ctx.fireAlarm(globe);
  const published = { total: 3, cities: [["berlin-de", 3]], min: MIN_PER_CITY, today: ["berlin-de"], waves: [] };
  assert.deepEqual(await heat(), published);
  assert.deepEqual(page.sent, [{ type: "heat", ...published, joins: ["berlin-de"] }]);
});

test(`cities with fewer than ${MIN_PER_CITY} machines stay off the public map`, async () => {
  await online(machine(1), "tokyo-jp");
  await online(machine(2), "tokyo-jp");
  await ctx.fireAlarm(globe);
  assert.deepEqual(await heat(), empty, "nothing shows before the hour");
  await online(machine(3), "tokyo-jp");
  await ctx.fireAlarm(globe);
  assert.deepEqual(await heat(), { ...empty, total: 3, cities: [["tokyo-jp", 3]], today: ["tokyo-jp"] });

  const local = new Globe(fakeCtx(), { MIN_PER_CITY: "1" });
  env.GLOBE.get = () => local;
  await online(machine(9), "oslo-no");
  await local.alarm();
  assert.deepEqual((await heat()).cities, [["oslo-no", 1]], "MIN_PER_CITY can be lowered for local testing");
});

test("moving and going offline keep counts right; raw ids are never stored", async () => {
  for (const n of [1, 2, 3]) await online(machine(n), "lisbon-pt");
  await online(machine(1), "porto-pt");
  await call("/api/offline", { body: { id: machine(2) } });
  const rows = ctx.db.prepare("SELECT key, city FROM presence ORDER BY city").all();
  assert.deepEqual(rows.map((r) => r.city), ["lisbon-pt", "porto-pt"]);
  for (const { key } of rows) assert.match(key, /^[0-9a-f]{64}$/);
  assert.ok(!JSON.stringify(rows).includes("machine-"));
  mock.timers.tick(HOUR);
  await ctx.fireAlarm(globe);
  assert.deepEqual(await heat(), { ...empty, total: 2, today: ["lisbon-pt", "porto-pt"] });
});

test("quiet cities change only on the hour, and leave a day after the last check-in", async () => {
  await ctx.fireAlarm(globe);
  mock.timers.tick(10 * 60_000);
  await online(machine(1), "bergen-no");
  await ctx.fireAlarm(globe);
  assert.deepEqual(await heat(), empty, "joined at 12:10, nothing shows before 13:00");
  assert.equal(await ctx.storage.getAlarm(), NOW + 25 * 60_000, "swept every 15 minutes");
  mock.timers.tick(40 * 60_000);
  await ctx.fireAlarm(globe);
  assert.equal(await ctx.storage.getAlarm(), NOW + HOUR, "and on the hour");

  mock.timers.tick(10 * 60_000);
  await ctx.fireAlarm(globe);
  assert.deepEqual(await heat(), { ...empty, total: 1, today: ["bergen-no"] });
  mock.timers.tick(20 * 60_000);
  await ctx.fireAlarm(globe);
  assert.deepEqual(await heat(), { ...empty, total: 1, today: ["bergen-no"] }, "offline since 13:15, counted until 14:00");
  mock.timers.tick(40 * 60_000);
  await ctx.fireAlarm(globe);
  assert.deepEqual(await heat(), { ...empty, today: ["bergen-no"] });

  mock.timers.tick(TODAY_MS);
  await ctx.fireAlarm(globe);
  assert.deepEqual(await heat(), empty);
  assert.equal(ctx.db.prepare("SELECT count(*) AS n FROM presence").get().n, 0, "hashes are gone a day after the last check-in");
  assert.equal(await ctx.storage.getAlarm(), null, "nothing left to sweep");
});

test("switching off forgets the hash at once; the map catches up on the hour", async () => {
  await online(machine(1), "bergen-no");
  mock.timers.tick(HOUR);
  await ctx.fireAlarm(globe);
  mock.timers.tick(10 * 60_000);
  await call("/api/offline", { body: { id: machine(1) } });
  assert.equal(ctx.db.prepare("SELECT count(*) AS n FROM presence").get().n, 0);
  await ctx.fireAlarm(globe);
  assert.deepEqual(await heat(), { ...empty, total: 1, today: ["bergen-no"] });
  mock.timers.tick(HOUR);
  await ctx.fireAlarm(globe);
  assert.deepEqual(await heat(), empty);
});

test("busy cities stay on the day layer for the rest of the hour", async () => {
  for (const n of [1, 2, 3]) await online(machine(n), "tokyo-jp");
  await ctx.fireAlarm(globe);
  await call("/api/offline", { body: { id: machine(3) } });
  await ctx.fireAlarm(globe);
  assert.deepEqual(await heat(), { ...empty, today: ["tokyo-jp"] });
});

test("history keeps one count per finished day and nothing else", async () => {
  await online(machine(1), "berlin-de");
  await online(machine(2), "berlin-de");
  await online(machine(2), "paris-fr");
  await online(machine(1), "berlin-de");
  mock.timers.tick(TODAY_MS - HOUR);
  for (const n of [1, 3, 4]) await online(machine(n), "berlin-de");
  assert.deepEqual(ctx.db.prepare("SELECT * FROM daily ORDER BY day").all().map((r) => ({ ...r })), [
    { day: 20741, n: 2 },
    { day: 20742, n: 3 },
  ]);
  assert.deepEqual(await call("/api/history").then((r) => r.json()), { days: [["2026-10-15", 2]] }, "today shows once it's over");

  mock.timers.tick(HISTORY_DAYS * TODAY_MS);
  await ctx.fireAlarm(globe);
  assert.equal(ctx.db.prepare("SELECT count(*) AS n FROM daily").get().n, 0, "a year is all that's kept");
});

test("waves reach every viewer, only for cities on the map", async () => {
  const wave = (city, kind = "wave", ip) => call("/api/wave", { body: { city, kind }, ip });
  await online(machine(1), "lima-pe");
  await ctx.fireAlarm(globe);
  assert.equal((await wave("lima-pe")).status, 400, "not on the map yet");
  mock.timers.tick(HOUR);
  await ctx.fireAlarm(globe);
  const page = viewer();
  assert.equal((await wave("lima-pe", "shout")).status, 400, "only the fixed kinds");
  assert.equal((await wave("lima-pe", "heart")).status, 200);
  assert.deepEqual(page.sent, [{ type: "wave", city: "lima-pe", kind: "heart" }]);

  const statuses = [];
  for (let i = 0; i < 11; i++) statuses.push((await wave("lima-pe", "wave", "10.7.7.7")).status);
  assert.deepEqual(statuses.slice(9), [200, 429]);
  await ctx.fireAlarm(globe);
  assert.deepEqual((await heat()).waves, [["lima-pe", 11]], "counted for a day");
  assert.equal((await call("/api/wave", { body: { city: "lima-pe", kind: "wave" }, headers: { origin: "https://evil.test" } })).status, 403);

  mock.timers.tick(TODAY_MS);
  await ctx.fireAlarm(globe);
  assert.equal(ctx.db.prepare("SELECT count(*) AS n FROM waves").get().n, 0);
});

test("adds since to an existing presence table", async () => {
  const old = fakeCtx();
  old.db.exec("CREATE TABLE presence (key TEXT PRIMARY KEY, city TEXT NOT NULL, seen INTEGER NOT NULL) WITHOUT ROWID");
  old.db.prepare("INSERT INTO presence VALUES ('k', 'oslo-no', 1)").run();
  new Globe(old, {});
  assert.deepEqual({ ...old.db.prepare("SELECT * FROM presence").get() }, { key: "k", city: "oslo-no", seen: 1, since: 0 });
});

test("limits new machines and moves, never plain heartbeats or going offline", async () => {
  const ip = "10.9.9.9";
  const statuses = [];
  for (let n = 0; n < 14; n++) statuses.push((await online(machine(n), "berlin-de", ip)).status);
  assert.deepEqual(statuses.slice(10), [200, 200, 429, 429]);
  for (let i = 0; i < 20; i++) assert.equal((await online(machine(0), "berlin-de", ip)).status, 200, "unchanged heartbeat");
  assert.equal((await call("/api/offline", { body: { id: machine(1) }, ip })).status, 200);
  assert.equal((await online(machine(20), "berlin-de", "10.9.9.8")).status, 200, "other IPs have their own budget");
  mock.timers.tick(60_000);
  assert.equal((await online(machine(13), "berlin-de", ip)).status, 200, "the window resets");
});

test("rejects bad input and cross-site writes", async () => {
  assert.equal((await online(machine(1), "atlantis-xx")).status, 400);
  assert.equal((await online("short", "berlin-de")).status, 400);
  assert.equal((await call("/api/online", { body: "{" })).status, 400);
  assert.equal((await call("/api/online", { body: { id: machine(1), city: "berlin-de", pad: "x".repeat(2000) } })).status, 400);
  assert.equal((await call("/api/online", { body: { id: machine(1), city: "berlin-de" }, headers: { origin: "https://evil.test" } })).status, 403);
  assert.equal((await call("/api/online", { body: { id: machine(1), city: "berlin-de" }, headers: { "content-type": "text/plain" } })).status, 415);
  assert.equal((await call("/api/share", { body: { id: machine(1), city: "berlin-de" } })).status, 404, "website sharing is gone");
});

test("plugin changes reach only the page it opened", async () => {
  const page = { sent: [], send: (m) => page.sent.push(JSON.parse(m)) };
  const other = { sent: [], send: (m) => other.sent.push(JSON.parse(m)) };
  ctx.getWebSockets = (tag) => (tag === "sync:abcdef0123456789abcd" ? [page] : [page, other]);
  const relay = (body) => call("/api/sync", { body });
  assert.equal((await relay({ sync: "abcdef0123456789abcd", theme: "81a1c1".repeat(20) })).status, 200);
  assert.equal((await relay({ sync: "abcdef0123456789abcd", me: "tokyo-jp" })).status, 200);
  assert.equal((await relay({ sync: "abcdef0123456789abcd", me: "" })).status, 200);
  assert.deepEqual(page.sent, [
    { type: "sync", theme: "81a1c1".repeat(20) },
    { type: "sync", me: "tokyo-jp" },
    { type: "sync", me: "" },
  ]);
  assert.deepEqual(other.sent, []);
  assert.equal((await relay({ sync: "abcdef0123456789abcd", theme: "<script>" })).status, 400);
  assert.equal((await relay({ sync: "short", theme: "81a1c1" })).status, 400);
  assert.equal((await relay({ sync: "abcdef0123456789abcd", me: "atlantis-xx" })).status, 400);
  assert.equal((await relay({ sync: "abcdef0123456789abcd" })).status, 400);
  assert.equal(ctx.db.prepare("SELECT count(*) AS n FROM presence").get().n, 0, "nothing is stored");
});

test("unknown routes and methods 404", async () => {
  assert.equal((await call("/api/nope")).status, 404);
  assert.equal((await call("/api/heat", { body: {} })).status, 404);
});
