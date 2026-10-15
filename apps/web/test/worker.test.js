import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, mock, test } from "node:test";
import { Globe, MIN_PER_CITY, HEARTBEAT_TTL_MS } from "../worker/globe.js";
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
    new Request(`https://omaglobe.test${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { "content-type": "application/json", origin: "https://omaglobe.test", "cf-connecting-ip": ip, ...headers },
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    }),
    env,
  );
const heat = () => call("/api/heat").then((r) => r.json());
const online = (id, city, ip) => call("/api/online", { body: { id, city }, ip });
const machine = (n) => `machine-${String(n).padStart(12, "0")}`;
const empty = { total: 0, cities: [], min: MIN_PER_CITY };

test("heat is published on the timer, not per request", async () => {
  for (const n of [1, 2, 3]) await online(machine(n), "berlin-de");
  assert.deepEqual(await heat(), empty);
  assert.ok((await ctx.storage.getAlarm()) > NOW, "a publish is scheduled");

  const viewer = { sent: [], send: (m) => viewer.sent.push(JSON.parse(m)) };
  ctx.sockets.push(viewer);
  await ctx.fireAlarm(globe);
  assert.deepEqual(await heat(), { total: 3, cities: [["berlin-de", 3]], min: MIN_PER_CITY });
  assert.deepEqual(viewer.sent, [{ type: "heat", total: 3, cities: [["berlin-de", 3]], min: MIN_PER_CITY, joins: ["berlin-de"] }]);
});

test(`cities with fewer than ${MIN_PER_CITY} machines stay off the public map`, async () => {
  await online(machine(1), "tokyo-jp");
  await online(machine(2), "tokyo-jp");
  await ctx.fireAlarm(globe);
  assert.deepEqual(await heat(), empty);
  await online(machine(3), "tokyo-jp");
  await ctx.fireAlarm(globe);
  assert.deepEqual((await heat()).cities, [["tokyo-jp", 3]]);

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
  assert.deepEqual(ctx.db.prepare("SELECT city, n FROM online ORDER BY city").all().map((r) => [r.city, r.n]), [
    ["lisbon-pt", 1],
    ["porto-pt", 1],
  ]);
});

test("machines drop off when heartbeats stop", async () => {
  for (const n of [1, 2, 3, 4]) await online(machine(n), "oslo-no");
  await ctx.fireAlarm(globe);
  assert.equal(await ctx.storage.getAlarm(), NOW + 15 * 60_000, "presence is swept every 15 minutes");

  mock.timers.tick(HEARTBEAT_TTL_MS - 60_000);
  const beat = await online(machine(1), "oslo-no").then((r) => r.json());
  assert.equal(beat.heat.total, 4, "a heartbeat returns the published map");
  mock.timers.tick(2 * 60_000);
  await ctx.fireAlarm(globe);
  assert.deepEqual(ctx.db.prepare("SELECT city, n FROM online").all().map((r) => [r.city, r.n]), [["oslo-no", 1]]);
  assert.deepEqual((await heat()).cities, []);
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
