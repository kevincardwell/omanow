import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeTheme } from "@omaglobe/core/theme.js";
import * as Model from "../dist/model.mjs";

test("snaps the weather location to a city without sending it", () => {
  assert.equal(Model.cityFromWeather('{"name":"Berlin","latitude":52.4,"longitude":13.1}'), "berlin-de");
  assert.equal(Model.cityFromWeather('{"name":"","latitude":null,"longitude":null}'), "");
  assert.equal(Model.cityFromWeather("not json"), "");
});

test("state is off unless it names a known city", () => {
  assert.deepEqual(Model.parseState('{"id":"0123456789abcdef0123","city":"berlin-de","online":true}'), {
    id: "0123456789abcdef0123",
    city: "berlin-de",
    online: true,
  });
  assert.equal(Model.parseState('{"city":"atlantis-xx","online":true}').online, false);
  assert.deepEqual(Model.parseState(""), { id: "", city: "", online: false });
});

test("install ids are long and random", () => {
  const ids = new Set(Array.from({ length: 100 }, Model.newId));
  assert.equal(ids.size, 100);
  for (const id of ids) assert.match(id, /^[0-9a-f]{32}$/);
});

test("server setting falls back to the public server", () => {
  assert.equal(Model.serverUrl(""), Model.DEFAULT_SERVER);
  assert.equal(Model.serverUrl("http://localhost:8787/"), "http://localhost:8787");
  assert.equal(Model.serverUrl("file:///etc/passwd"), Model.DEFAULT_SERVER);
});

test("theme link carries the colors in the fragment only", () => {
  const link = Model.themeLink("http://localhost:8787", 'accent = "#81a1c1"\nbackground = "#2e3440"\n');
  const [base, fragment] = link.split("#theme=");
  assert.equal(base, "http://localhost:8787/");
  assert.equal(decodeTheme(fragment).accent, "#81a1c1");
  assert.equal(Model.themeLink("http://x.test", ""), "http://x.test/");
});

test("summary and visibility", () => {
  const heat = { total: 1234, online: 5, cities: [["berlin-de", 4]], min: 3 };
  assert.match(Model.summary(heat), /on the map · 5 online · 1 cities/);
  assert.equal(Model.cityShown(heat, "berlin-de"), true);
  assert.equal(Model.cityShown(heat, "oslo-no"), false);
  assert.ok(Model.cityOptions().every((o) => o.value && o.label));
});
