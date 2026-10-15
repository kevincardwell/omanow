import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createOmaglobeServer } from "../server/server.js";

let server;
let base;
const dataFile = join(mkdtempSync(join(tmpdir(), "omaglobe-")), "optins.json");
const id = "0123456789abcdef-test";

before(async () => {
  const meetups = async () => ({ at: 0, meetups: [{ id: "evt-1", name: "Omarchy Prague" }] });
  server = createOmaglobeServer({ dataFile, theme: () => ({ accent: "#ffffff" }), meetups });
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  server.closeAllConnections();
  server.close();
});

const post = (path, body) => fetch(base + path, { method: "POST", body: JSON.stringify(body) });
const heat = () => fetch(`${base}/api/heat`).then((r) => r.json());

test("share, move and unshare a city", async () => {
  assert.deepEqual(await heat(), { total: 0, cities: [] });

  assert.equal((await post("/api/share", { id, city: "berlin-de" })).status, 200);
  assert.deepEqual(await heat(), { total: 1, cities: [["berlin-de", 1]] });

  await post("/api/share", { id, city: "tokyo-jp" });
  assert.deepEqual(await heat(), { total: 1, cities: [["tokyo-jp", 1]] });

  const stored = readFileSync(dataFile, "utf8");
  assert.ok(!stored.includes(id), "raw client id must not be persisted");

  await post("/api/unshare", { id });
  assert.deepEqual(await heat(), { total: 0, cities: [] });
});

test("rejects unknown cities and malformed ids", async () => {
  assert.equal((await post("/api/share", { id, city: "atlantis-xx" })).status, 400);
  assert.equal((await post("/api/share", { id: "short", city: "berlin-de" })).status, 400);
  assert.equal((await post("/api/share", { id, city: "berlin-de", lat: 1 })).status, 200);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(dataFile, "utf8"))).length, 1);
  await post("/api/unshare", { id });
});

test("event stream sends heat and join events", async () => {
  const ctrl = new AbortController();
  const res = await fetch(`${base}/api/events`, { signal: ctrl.signal });
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let text = "";
  const read = async (needle) => {
    while (!text.includes(needle)) text += dec.decode((await reader.read()).value);
  };
  await read("event: heat");
  await post("/api/share", { id, city: "lisbon-pt" });
  await read('event: join\ndata: {"city":"lisbon-pt"}');
  await read('"lisbon-pt",1');
  ctrl.abort();
  await post("/api/unshare", { id });
});

test("serves the page and theme, blocks traversal", async () => {
  assert.match(await fetch(base + "/").then((r) => r.text()), /<canvas id="globe"/);
  assert.equal((await fetch(`${base}/core/scene.js`)).status, 200);
  assert.equal((await fetch(`${base}/..%2fpackage.json`)).status, 404);
  assert.deepEqual(await fetch(`${base}/api/theme`).then((r) => r.json()), { accent: "#ffffff" });
});

test("serves meetups", async () => {
  const data = await fetch(`${base}/api/meetups`).then((r) => r.json());
  assert.equal(data.meetups[0].name, "Omarchy Prague");
  assert.equal(data.source, "https://luma.com/omarchy");
});
