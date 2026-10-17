import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeTheme } from "@omanow/core/theme.js";
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
    sync: "",
  });
  assert.equal(Model.parseState('{"city":"atlantis-xx","online":true}').online, false);
  assert.deepEqual(Model.parseState(""), { id: "", city: "", online: false, sync: "" });
  assert.equal(Model.parseState('{"sync":"abcdef0123456789abcd"}').sync, "abcdef0123456789abcd");
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

test("page link carries theme, city and sync in the fragment only", () => {
  const theme = Model.themeHex('accent = "#81a1c1"\nbackground = "#2e3440"\n');
  const link = Model.pageLink("http://localhost:8787", { theme, city: "tokyo-jp", sync: "abc" });
  const [base, fragment] = link.split("#");
  assert.equal(base, "http://localhost:8787/");
  const params = new URLSearchParams(fragment);
  assert.equal(decodeTheme(params.get("theme")).accent, "#81a1c1");
  assert.equal(params.get("me"), "tokyo-jp");
  assert.equal(params.get("sync"), "abc");
  assert.equal(Model.pageLink("http://x.test", {}), "http://x.test/");
  assert.equal(Model.themeHex(""), "");
});

test("locates by timezone from tzdata, offline", () => {
  const tab = "# comment\nDK\t+5540+01235\tEurope/Copenhagen\nJP\t+353916+1394441\tAsia/Tokyo\nBR\t-2332-04637\tAmerica/Sao_Paulo\n";
  assert.equal(Model.zoneFromPath("/usr/share/zoneinfo/Asia/Tokyo\n"), "Asia/Tokyo");
  assert.equal(Model.cityFromZone(tab, "Asia/Tokyo"), "tokyo-jp");
  assert.equal(Model.cityFromZone(tab, "Europe/Copenhagen"), "copenhagen-dk");
  assert.equal(Model.cityFromZone(tab, "America/Sao_Paulo"), "sao-paulo-br");
  assert.equal(Model.cityFromZone(tab, "Mars/Olympus"), "");
});

test("retries back off and cap at 30 minutes", () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6, 9].map((n) => Model.retryDelay(n) / 60000), [1, 2, 4, 8, 16, 30, 30]);
});

test("waves to your city", () => {
  const heat = { total: 6, cities: [], today: ["tokyo-jp"], waves: [["tokyo-jp", 3], ["oslo-no", 1]] };
  assert.equal(Model.wavesTo(heat, "tokyo-jp"), "3 waves to tokyo today");
  assert.equal(Model.wavesTo(heat, "oslo-no"), "1 wave to oslo today");
  assert.equal(Model.wavesTo(heat, "berlin-de"), "");
  assert.equal(Model.wavesTo(null, "tokyo-jp"), "");
});

test("summary and options", () => {
  const heat = { total: 1234, cities: [["berlin-de", 4]], min: 3 };
  assert.match(Model.summary(heat), /machines online · 1 city$/);
  assert.equal(Model.summary({ total: 1, cities: [["berlin-de", 1]] }), "1 machine online · 1 city");
  assert.equal(Model.summary({ total: 6, cities: [], today: ["berlin-de", "oslo-no"] }), "6 machines online · 2 cities today");
  assert.equal(Model.summary({ total: 1, cities: [], today: ["oslo-no"] }), "1 machine online · 1 city today");
  assert.ok(Model.cityOptions().every((o) => o.value && o.label));
});
