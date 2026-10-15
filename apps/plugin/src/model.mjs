// Logic for the omaglobe bar widget, kept out of QML so Node can test it.
// cities.mjs and theme.mjs are copied from @omaglobe/core at build time.

import { CITIES, CITY_BY_ID, nearestCity } from "./cities.mjs";
import { encodeTheme, parseColorsToml } from "./theme.mjs";

export const DEFAULT_SERVER = "https://omaglobe.mark-omarov.workers.dev";
export const HEARTBEAT_MS = 3600000;

/** A random install id, so this machine's heartbeats replace each other
 *  instead of piling up. The server only keeps its hash. */
export function newId() {
  let id = "";
  while (id.length < 32) id += Math.floor(Math.random() * 0x100000000).toString(16).padStart(8, "0");
  return id;
}

export function cityLabel(id) {
  const city = CITY_BY_ID.get(id);
  return city ? `${city.name}, ${city.country}` : "";
}

export function cityOptions() {
  return [...CITIES]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((c) => ({ value: c.id, label: `${c.name}, ${c.country}` }));
}

/** The city nearest to the weather widget's saved location, if it has one.
 *  The coordinates are used here only and never sent anywhere. */
export function cityFromWeather(text) {
  try {
    const { latitude, longitude } = JSON.parse(text);
    const lat = parseFloat(latitude);
    const lon = parseFloat(longitude);
    return Number.isFinite(lat) && Number.isFinite(lon) ? nearestCity(lat, lon).id : "";
  } catch (e) {
    return "";
  }
}

export function parseState(text) {
  try {
    const s = JSON.parse(text);
    return {
      id: typeof s.id === "string" && /^[A-Za-z0-9-]{16,64}$/.test(s.id) ? s.id : "",
      city: CITY_BY_ID.has(s.city) ? s.city : "",
      online: s.online === true && CITY_BY_ID.has(s.city),
    };
  } catch (e) {
    return { id: "", city: "", online: false };
  }
}

export function serverUrl(setting) {
  const url = String(setting || "").trim().replace(/\/+$/, "");
  return /^https?:\/\/[^\s/]+$/.test(url) ? url : DEFAULT_SERVER;
}

export function themeLink(server, colorsToml) {
  const colors = parseColorsToml(colorsToml || "");
  return Object.keys(colors).length ? `${server}/#theme=${encodeTheme(colors)}` : `${server}/`;
}

const fmt = (n) => Number(n || 0).toLocaleString();

export function summary(heat) {
  if (!heat) return "";
  return `${fmt(heat.total)} on the map · ${fmt(heat.online)} online · ${fmt(heat.cities?.length)} cities`;
}

/** Whether this city is visible yet; small cities stay hidden until enough
 *  people share them. */
export function cityShown(heat, city) {
  return !!heat?.cities?.some(([id]) => id === city);
}
