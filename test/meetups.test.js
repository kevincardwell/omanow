import assert from "node:assert/strict";
import { test } from "node:test";
import { createMeetupsSource, normalizeLumaEntries } from "../server/meetups.js";

const entry = (over = {}, evOver = {}) => ({
  guest_count: 12,
  hosts: [{ name: "Ada" }],
  event: {
    api_id: "evt-1",
    name: "Omarchy Prague",
    url: "v9bjvpbu",
    start_at: "2026-09-29T16:00:00.000Z",
    end_at: "2026-09-29T19:00:00.000Z",
    timezone: "Europe/Prague",
    location_type: "offline",
    geo_address_info: { city: "Prague", country: "Czechia" },
    coordinate: { latitude: 50.087654, longitude: 14.421234 },
    ...evOver,
  },
  ...over,
});

test("normalizes Luma entries", () => {
  const [m] = normalizeLumaEntries([entry(), { event: null }, { event: { api_id: "x" } }]);
  assert.deepEqual(m, {
    id: "evt-1",
    name: "Omarchy Prague",
    url: "https://luma.com/v9bjvpbu",
    start: "2026-09-29T16:00:00.000Z",
    end: "2026-09-29T19:00:00.000Z",
    timezone: "Europe/Prague",
    city: "Prague",
    region: null,
    country: "Czechia",
    lat: 50.088,
    lon: 14.421,
    near: null,
    online: false,
    guests: 12,
    cover: null,
    hosts: ["Ada"],
  });
});

test("places coordinate-less events by timezone without inventing a city", () => {
  const [a, b, c] = normalizeLumaEntries([
    entry({}, { api_id: "a", coordinate: null, geo_address_info: null, timezone: "America/Sao_Paulo", location_type: "youtube" }),
    entry({}, { api_id: "b", coordinate: null, geo_address_info: null, timezone: "Africa/Abidjan", location_type: "meet" }),
    entry({}, { api_id: "c", coordinate: null, geo_address_info: null, timezone: "Mars/Olympus" }),
  ]);
  assert.equal(a.near, "São Paulo");
  assert.equal(a.city, null);
  assert.equal(a.online, true);
  assert.ok(Math.abs(a.lat + 23.55) < 0.01);
  assert.equal(b.near, "Abidjan");
  assert.equal(c.lat, null);
});

test("merges future+past, caches, and serves stale data when Luma fails", async () => {
  let calls = 0;
  let fail = false;
  const fetch = async (url) => {
    calls++;
    if (fail) throw new Error("offline");
    const past = url.includes("period=past");
    return { ok: true, json: async () => ({ entries: [entry({}, past ? { api_id: "p", start_at: "2026-01-01T00:00:00.000Z" } : {})] }) };
  };
  const get = createMeetupsSource({ fetch, ttl: 0 });
  const first = await get();
  assert.deepEqual(first.meetups.map((m) => m.id), ["p", "evt-1"]);
  fail = true;
  assert.deepEqual((await get()).meetups.map((m) => m.id), ["p", "evt-1"]);
  assert.equal(calls, 4);

  const cold = createMeetupsSource({ fetch: async () => ({ ok: false, status: 503 }) });
  await assert.rejects(cold());
});
