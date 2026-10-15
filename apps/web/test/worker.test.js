import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, mock, test } from "node:test";
import { Globe, MIN_PEOPLE, ONLINE_MS, RETENTION_DAYS } from "../worker/globe.js";
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
const share = (id, city) => call("/api/share", { body: { id, city } });
const person = (n) => `person-${String(n).padStart(12, "0")}`;

test("heat is published on the timer, not per request", async () => {
  await share(person(1), "berlin-de");
  await share(person(2), "berlin-de");
  await share(person(3), "berlin-de");
  assert.deepEqual(await heat(), { total: 0, cities: [], online: 0, onlineCities: [], min: MIN_PEOPLE });
  assert.ok((await ctx.storage.getAlarm()) > NOW, "a publish is scheduled");

  const viewer = { sent: [], send: (m) => viewer.sent.push(JSON.parse(m)) };
  ctx.sockets.push(viewer);
  await ctx.fireAlarm(globe);
  assert.deepEqual(await heat(), { total: 3, cities: [["berlin-de", 3]], online: 0, onlineCities: [], min: MIN_PEOPLE });
  assert.deepEqual(viewer.sent, [{ type: "heat", total: 3, cities: [["berlin-de", 3]], online: 0, onlineCities: [], min: MIN_PEOPLE, joins: ["berlin-de"] }]);
});

test(`cities with fewer than ${MIN_PEOPLE} people stay off the public map`, async () => {
  await share(person(1), "tokyo-jp");
  await share(person(2), "tokyo-jp");
  await ctx.fireAlarm(globe);
  assert.deepEqual(await heat(), { total: 0, cities: [], online: 0, onlineCities: [], min: MIN_PEOPLE });
  await share(person(3), "tokyo-jp");
  await ctx.fireAlarm(globe);
  assert.deepEqual((await heat()).cities, [["tokyo-jp", 3]]);
});

test("move and unshare keep counts right; raw ids are never stored", async () => {
  for (const n of [1, 2, 3]) await share(person(n), "lisbon-pt");
  await share(person(1), "porto-pt");
  await call("/api/unshare", { body: { id: person(2) } });
  const rows = ctx.db.prepare("SELECT key, city FROM optins ORDER BY city").all();
  assert.deepEqual(rows.map((r) => r.city), ["lisbon-pt", "porto-pt"]);
  for (const { key } of rows) assert.match(key, /^[0-9a-f]{64}$/);
  assert.ok(!JSON.stringify(rows).includes("person-"));
  assert.deepEqual(ctx.db.prepare("SELECT city, n FROM counts ORDER BY city").all().map((r) => [r.city, r.n]), [
    ["lisbon-pt", 1],
    ["porto-pt", 1],
  ]);
});

test("rejects bad input, cross-site writes and floods", async () => {
  assert.equal((await share(person(1), "atlantis-xx")).status, 400);
  assert.equal((await share("short", "berlin-de")).status, 400);
  assert.equal((await call("/api/share", { body: "{" })).status, 400);
  assert.equal((await call("/api/share", { body: { id: person(1), city: "berlin-de", pad: "x".repeat(2000) } })).status, 413);
  assert.equal((await call("/api/share", { body: { id: person(1), city: "berlin-de" }, headers: { origin: "https://evil.test" } })).status, 403);
  assert.equal((await call("/api/share", { body: { id: person(1), city: "berlin-de" }, headers: { "content-type": "text/plain" } })).status, 415);

  const statuses = [];
  for (let n = 0; n < 8; n++) statuses.push((await call("/api/share", { body: { id: person(n), city: "berlin-de" }, ip: "10.9.9.9" })).status);
  assert.deepEqual(statuses, [200, 200, 200, 200, 200, 200, 429, 429]);
  assert.equal((await call("/api/unshare", { body: { id: person(0) }, ip: "10.9.9.9" })).status, 200, "stopping is never limited");
  assert.equal((await call("/api/share", { body: { id: person(9), city: "berlin-de" }, ip: "10.9.9.8" })).status, 200);
  mock.timers.tick(60_000);
  assert.equal((await call("/api/share", { body: { id: person(7), city: "berlin-de" }, ip: "10.9.9.9" })).status, 200);
});

test(`opt-ins expire after ${RETENTION_DAYS} days without a visit`, async () => {
  for (const n of [1, 2, 3, 4]) await share(person(n), "berlin-de");
  await ctx.fireAlarm(globe);
  assert.equal(await ctx.storage.getAlarm(), NOW + 86_400_000, "a daily sweep stays scheduled");

  mock.timers.tick(100 * 86_400_000);
  await share(person(4), "berlin-de"); // a return visit re-affirms
  mock.timers.tick((RETENTION_DAYS - 99) * 86_400_000);
  await ctx.fireAlarm(globe);
  assert.deepEqual(ctx.db.prepare("SELECT count(*) AS n FROM optins").get().n, 1);
  assert.deepEqual((await heat()).cities, []);
});

test("plugins count as online until their heartbeats stop", async () => {
  const online = (id, city) => call("/api/online", { body: { id, city } });
  await share(person(1), "oslo-no");
  for (const n of [2, 3, 4]) await online(person(n), "oslo-no");
  await online(person(5), "oslo-no");
  await call("/api/offline", { body: { id: person(5) } });
  await ctx.fireAlarm(globe);
  assert.deepEqual(await heat(), { total: 4, cities: [["oslo-no", 4]], online: 3, onlineCities: [["oslo-no", 3]], min: MIN_PEOPLE });
  assert.equal(await ctx.storage.getAlarm(), NOW + 15 * 60_000, "presence is swept every 15 minutes");

  mock.timers.tick(ONLINE_MS - 60_000);
  const beat = await online(person(2), "oslo-no").then((r) => r.json());
  assert.equal(beat.heat.online, 3, "a heartbeat returns the published map");
  mock.timers.tick(2 * 60_000);
  await ctx.fireAlarm(globe);
  assert.deepEqual(ctx.db.prepare("SELECT city, n FROM online").all().map((r) => [r.city, r.n]), [["oslo-no", 1]]);
  assert.deepEqual((await heat()).cities, [], "1 web + 1 online is below the threshold");
});

test("unknown routes and methods 404", async () => {
  assert.equal((await call("/api/nope")).status, 404);
  assert.equal((await call("/api/heat", { body: {} })).status, 404);
});
