// Omarchy meetups, from the listing omarchy.org/meetups is built from
// (omacom/omarchy-site, refreshed daily from the Luma calendar). Normalized
// to the few fields the globe needs and cached in memory.

import { CITIES } from "../src/core/cities.js";

export const MEETUPS_URL = "https://raw.githubusercontent.com/omacom/omarchy-site/master/src/data/meetups.json";
export const MEETUPS_PAGE = "https://omarchy.org/meetups";
const SITE = "https://omarchy.org";
const TTL_MS = 10 * 60 * 1000;

const round = (n) => Math.round(n * 1000) / 1000;
const isNum = (n) => typeof n === "number" && Number.isFinite(n);

// The listing places hidden addresses by title; the rare event it can't place
// falls back to its timezone city so it still lands in the region.
const fold = (s) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const CITY_BY_NAME = new Map(CITIES.map((c) => [fold(c.name), c]));
const TZ_EXTRA = {
  "Africa/Abidjan": ["Abidjan", 5.36, -4.01],
  "Asia/Qatar": ["Doha", 25.29, 51.53],
  "Asia/Calcutta": ["Kolkata", 22.57, 88.36],
  "Asia/Kolkata": ["Kolkata", 22.57, 88.36],
  "Asia/Saigon": ["Ho Chi Minh City", 10.82, 106.63],
  "Asia/Katmandu": ["Kathmandu", 27.72, 85.32],
  "Europe/Kiev": ["Kyiv", 50.45, 30.52],
};

function locateTimezone(tz) {
  if (typeof tz !== "string") return null;
  if (TZ_EXTRA[tz]) {
    const [city, lat, lon] = TZ_EXTRA[tz];
    return { city, lat, lon };
  }
  const city = CITY_BY_NAME.get(fold(tz.split("/").pop().replace(/_/g, " ")));
  return city ? { city: city.name, lat: city.lat, lon: city.lon } : null;
}

const https = (u, base) => {
  try {
    const url = new URL(u, base);
    return url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
};

const text = (s) => (typeof s === "string" && s ? s : null);

export function normalizeMeetups(data) {
  const out = [];
  for (const ev of data?.events || []) {
    if (!text(ev?.id) || !text(ev.title) || !Number.isFinite(Date.parse(ev.start))) continue;
    let lat = ev.geo?.lat;
    let lon = ev.geo?.lon;
    let near = null; // timezone city used for placement when the listing has no place

    if (!isNum(lat) || !isNum(lon)) {
      const guess = locateTimezone(ev.timezone);
      lat = guess?.lat;
      lon = guess?.lon;
      near = guess?.city || null;
    }
    out.push({
      id: ev.id,
      name: ev.title,
      url: https(ev.url),
      start: ev.start,
      end: Number.isFinite(Date.parse(ev.end)) ? ev.end : null,
      timezone: text(ev.timezone),
      city: text(ev.city),
      country: text(ev.country),
      lat: isNum(lat) ? round(lat) : null,
      lon: isNum(lon) ? round(lon) : null,
      approximate: ev.geo?.approximate === true,
      near,
      online: ev.online === true,
      hosts: (Array.isArray(ev.hosts) ? ev.hosts : []).filter((h) => typeof h === "string" && h).slice(0, 4),
      cover: text(ev.cover) && https(ev.cover, SITE),
    });
  }
  return out.sort((a, b) => a.start.localeCompare(b.start));
}

export function createMeetupsSource({ fetch: fetchImpl = globalThis.fetch, url = MEETUPS_URL, ttl = TTL_MS } = {}) {
  let cache = null; // { at, meetups }
  let inflight = null;
  let retryAt = 0;

  async function refresh() {
    const res = await fetchImpl(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`meetups: HTTP ${res.status}`);
    cache = { at: Date.now(), meetups: normalizeMeetups(await res.json()) };
    return cache;
  }

  // Serves the cache while fresh. A failed refresh keeps serving stale data
  // and waits a full ttl before trying the upstream again.
  return async function get() {
    const now = Date.now();
    if (cache && now - cache.at < ttl) return cache;
    if (now < retryAt) {
      if (cache) return cache;
      throw new Error("meetups unavailable");
    }
    inflight ??= refresh()
      .catch((err) => {
        retryAt = Date.now() + ttl;
        throw err;
      })
      .finally(() => (inflight = null));
    try {
      return await inflight;
    } catch (err) {
      if (cache) return cache;
      throw err;
    }
  };
}
