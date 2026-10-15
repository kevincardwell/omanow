import assert from "node:assert/strict";
import { test } from "node:test";
import { createMeetupsSource, normalizeMeetups } from "../worker/meetups.js";

// Shape of omacom/omarchy-site src/data/meetups.json.
const event = (over = {}) => ({
  id: "evt-1",
  title: "Omarchy Prague",
  url: "https://luma.com/v9bjvpbu",
  start: "2026-09-29T16:00:00.000Z",
  end: "2026-09-29T19:00:00.000Z",
  timezone: "Europe/Prague",
  address: "Somewhere 1, Prague",
  city: "Prague",
  country: "CZ",
  online: false,
  geo: { lat: 50.087654, lon: 14.421234 },
  hosts: ["Ada"],
  cover: "/images/meetups/evt-1-full.webp",
  coverWidth: 800,
  coverHeight: 800,
  ...over,
});

test("normalizes the omarchy.org listing", () => {
  const [m] = normalizeMeetups({ events: [event(), null, { id: "x" }, event({ id: "bad", start: "soon" })] });
  assert.deepEqual(m, {
    id: "evt-1",
    name: "Omarchy Prague",
    url: "https://luma.com/v9bjvpbu",
    start: "2026-09-29T16:00:00.000Z",
    end: "2026-09-29T19:00:00.000Z",
    timezone: "Europe/Prague",
    city: "Prague",
    country: "CZ",
    lat: 50.088,
    lon: 14.421,
    approximate: false,
    near: null,
    online: false,
    hosts: ["Ada"],
    cover: "https://omarchy.org/images/meetups/evt-1-full.webp",
  });
  assert.equal(normalizeMeetups({ events: [event({ url: "javascript:alert(1)" })] })[0].url, null);
});

test("keeps approximate places and falls back to the timezone city", () => {
  const [a, b, c] = normalizeMeetups({
    events: [
      event({ id: "a", geo: { lat: -23.55, lon: -46.63, approximate: true } }),
      event({ id: "b", start: "2026-10-01T00:00:00.000Z", geo: null, city: null, timezone: "America/Sao_Paulo" }),
      event({ id: "c", start: "2026-10-02T00:00:00.000Z", geo: { lat: null, lon: null }, timezone: "Mars/Olympus" }),
    ],
  });
  assert.equal(a.approximate, true);
  assert.equal(a.near, null);
  assert.equal(b.near, "São Paulo");
  assert.equal(b.city, null);
  assert.ok(Math.abs(b.lat + 23.55) < 0.01);
  assert.equal(c.lat, null);
});

test("caches, serves stale data when the listing fails, and backs off", async () => {
  let calls = 0;
  let fail = false;
  const fetch = async () => {
    calls++;
    if (fail) throw new Error("offline");
    return { ok: true, json: async () => ({ events: [event(), event({ id: "p", start: "2026-01-01T00:00:00.000Z" })] }) };
  };
  const get = createMeetupsSource({ fetch, ttl: 0 });
  const first = await get();
  assert.deepEqual(first.meetups.map((m) => m.id), ["p", "evt-1"]);
  fail = true;
  assert.deepEqual((await get()).meetups.map((m) => m.id), ["p", "evt-1"]);
  assert.equal(calls, 2);

  let coldCalls = 0;
  const cold = createMeetupsSource({ fetch: async () => (coldCalls++, { ok: false, status: 503 }) });
  await assert.rejects(cold());
  await assert.rejects(cold());
  assert.equal(coldCalls, 1, "a failed upstream is not hit again on every request");
});
