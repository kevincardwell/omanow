// Omarchy meetups, from the public Luma calendar that omarchy.org/meetups
// lists. Normalized to the few fields the globe needs and cached in memory.

import { CITIES } from "../src/core/cities.js";

export const LUMA_CALENDAR_ID = "cal-SDGGMsEps9ExsrT"; // luma.com/omarchy
const LUMA_API = "https://api.lu.ma/calendar/get-items";
const TTL_MS = 10 * 60 * 1000;

const round = (n) => Math.round(n * 1000) / 1000;
const ONLINE = new Set(["meet", "zoom", "youtube", "online", "virtual"]);

// Online events and hidden addresses carry no coordinates. Like omarchy.org,
// fall back to the event's timezone city so they still land in the region.
const fold = (s) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
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

export function normalizeLumaEntries(entries) {
  const out = [];
  for (const entry of entries || []) {
    const ev = entry?.event;
    if (!ev?.api_id || !ev.name || !ev.start_at) continue;
    const geo = ev.geo_address_info || {};
    let lat = Number(ev.coordinate?.latitude);
    let lon = Number(ev.coordinate?.longitude);
    let near = null; // timezone city used for placement when there's no address

    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      const guess = locateTimezone(ev.timezone);
      lat = guess ? guess.lat : NaN;
      lon = guess ? guess.lon : NaN;
      near = guess?.city || null;
    }
    out.push({
      id: ev.api_id,
      name: ev.name,
      url: `https://luma.com/${ev.url}`,
      start: ev.start_at,
      end: ev.end_at || null,
      timezone: ev.timezone || null,
      city: geo.city || null,
      region: geo.region || null,
      country: geo.country || null,
      lat: Number.isFinite(lat) ? round(lat) : null,
      lon: Number.isFinite(lon) ? round(lon) : null,
      near,
      online: ONLINE.has(ev.location_type),
      guests: Number.isFinite(entry.guest_count) ? entry.guest_count : null,
      cover: typeof ev.cover_url === "string" ? ev.cover_url : null,
      hosts: (entry.hosts || []).map((h) => h?.name).filter(Boolean).slice(0, 4),
    });
  }
  return out;
}

export function createMeetupsSource({ fetch: fetchImpl = globalThis.fetch, calendarId = LUMA_CALENDAR_ID, ttl = TTL_MS } = {}) {
  let cache = null; // { at, meetups }
  let inflight = null;

  async function load(period) {
    const url = `${LUMA_API}?calendar_api_id=${calendarId}&period=${period}&pagination_limit=100`;
    const res = await fetchImpl(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`luma ${period}: HTTP ${res.status}`);
    return normalizeLumaEntries((await res.json()).entries);
  }

  async function refresh() {
    const [future, past] = await Promise.all([load("future"), load("past")]);
    const seen = new Set();
    const meetups = [...future, ...past].filter((m) => !seen.has(m.id) && seen.add(m.id));
    meetups.sort((a, b) => a.start.localeCompare(b.start));
    cache = { at: Date.now(), meetups };
    return cache;
  }

  // Serves the cache while fresh; on a failed refresh keeps serving stale data.
  return async function get() {
    if (cache && Date.now() - cache.at < ttl) return cache;
    inflight ??= refresh().finally(() => (inflight = null));
    try {
      return await inflight;
    } catch (err) {
      if (cache) return cache;
      throw err;
    }
  };
}
