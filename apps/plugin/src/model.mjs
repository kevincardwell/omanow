// Logic for the omaglobe bar widget, kept out of QML so Node can test it.
// cities.mjs and theme.mjs are copied from @omaglobe/core at build time.

import { CITIES, CITY_BY_ID, nearestCity } from "./cities.mjs";
import { encodeTheme, parseColorsToml } from "./theme.mjs";

export const DEFAULT_SERVER = "https://omaglobe.mark-omarov.workers.dev";
export const HEARTBEAT_MS = 3600000;

/** Wait before retrying a failed request: 1, 2, 4... minutes, capped at 30. */
export function retryDelay(failures) {
  return Math.min(30, Math.pow(2, Math.max(0, failures - 1))) * 60000;
}

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

/** The timezone name from /etc/localtime's target. */
export function zoneFromPath(path) {
  const m = /zoneinfo\/(.+)$/.exec(String(path || "").trim());
  return m ? m[1] : "";
}

// zone.tab coordinates are ISO 6709: +DDMM[SS] then +DDDMM[SS].
function parseIso6709(text) {
  const m = /^([+-])(\d{2})(\d{2})(\d{2})?([+-])(\d{3})(\d{2})(\d{2})?$/.exec(text);
  if (!m) return null;
  const deg = (sign, d, mm, ss) => (sign === "-" ? -1 : 1) * (Number(d) + Number(mm) / 60 + Number(ss || 0) / 3600);
  return { lat: deg(m[1], m[2], m[3], m[4]), lon: deg(m[5], m[6], m[7], m[8]) };
}

/** The city nearest to the system timezone's reference point, from tzdata. */
export function cityFromZone(zoneTab, zone) {
  if (!zone) return "";
  for (const line of String(zoneTab || "").split("\n")) {
    const cols = line.split("\t");
    if (cols[2] !== zone) continue;
    const at = parseIso6709(cols[1]);
    return at ? nearestCity(at.lat, at.lon).id : "";
  }
  return "";
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

export function themeHex(colorsToml) {
  const colors = parseColorsToml(colorsToml || "");
  return Object.keys(colors).length ? encodeTheme(colors) : "";
}

/** The page link: theme, your city and a sync channel ride in the fragment,
 *  which browsers never send to the server. */
export function pageLink(server, { theme, city, sync }) {
  const parts = [];
  if (theme) parts.push(`theme=${theme}`);
  if (city) parts.push(`me=${city}`);
  if (sync) parts.push(`sync=${sync}`);
  return `${server}/${parts.length ? `#${parts.join("&")}` : ""}`;
}

const fmt = (n) => Number(n || 0).toLocaleString();

export function summary(heat) {
  if (!heat) return "";
  return `${fmt(heat.total)} on the map · ${fmt(heat.online)} online · ${fmt(heat.cities && heat.cities.length)} cities`;
}
