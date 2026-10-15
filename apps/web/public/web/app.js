// Web host for the omaglobe scene: owns the canvas, clock, input, network
// and the opt-in UI. Everything visual lives in ../core so another host
// (e.g. an Omarchy shell plugin) can drive the same scene.

import { CITIES, CITY_BY_ID, nearestCity } from "../core/cities.js";
import { createScene } from "../core/scene.js";
import { createMeetupsUi } from "./meetups.js";
import { createThemePicker } from "./themes.js";

const TARGET_ROWS = 270; // framebuffer height the pixel scale aims for
const ID_KEY = "omaglobe.id";
const CITY_KEY = "omaglobe.city";

const $ = (id) => document.getElementById(id);
const canvas = $("globe");
const ctx = canvas.getContext("2d");

const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const scene = createScene({ autoRotate: !reducedMotion });

// The plugin opens this page with its theme, its city and a sync channel in
// the fragment, which never reaches the server. Kept for this tab only.
const fromPlugin = (() => {
  const params = new URLSearchParams(location.hash.slice(1));
  if (location.hash) history.replaceState(null, "", location.pathname + location.search);
  const fresh = { theme: params.get("theme"), city: params.get("me"), sync: params.get("sync") };
  try {
    if (fresh.theme || fresh.city || fresh.sync) sessionStorage.setItem("omaglobe.plugin", JSON.stringify(fresh));
    return JSON.parse(sessionStorage.getItem("omaglobe.plugin")) || {};
  } catch {
    return fresh;
  }
})();
const themes = createThemePicker({ select: $("theme"), scene, storage, linked: fromPlugin.theme });

// ------------------------------------------------------------------ render

let scale = 3;
let image = null;

function resize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  scale = Math.max(2, Math.min(6, Math.round(h / TARGET_ROWS)));
  while (scale > 2 && w / scale < 240) scale--;
  const W = Math.ceil(w / scale);
  const H = Math.ceil(h / scale);
  scene.resize(W, H);
  canvas.width = W;
  canvas.height = H;
  canvas.style.width = `${W * scale}px`;
  canvas.style.height = `${H * scale}px`;
  image = new ImageData(scene.pixels, W, H);
}

let last = performance.now();
function frame(now) {
  scene.tick((now - last) / 1000);
  last = now;
  ctx.putImageData(image, 0, 0);
  requestAnimationFrame(frame);
}

window.addEventListener("resize", resize);
resize();
requestAnimationFrame(frame);

// ------------------------------------------------------------------- input

// Canvas pixels are framebuffer pixels scaled up, so client -> fb is a divide.
const toFb = (e) => {
  const r = canvas.getBoundingClientRect();
  return [(e.clientX - r.left) / scale, (e.clientY - r.top) / scale];
};

const pointers = new Map(); // pointerId -> { x, y }
let press = null; // { x, y, moved } for click-vs-drag
let pinch = 0;

canvas.addEventListener("pointerdown", (e) => {
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  canvas.setPointerCapture(e.pointerId);
  canvas.classList.add("dragging");
  scene.setDragging(true);
  press = pointers.size === 1 ? { x: e.clientX, y: e.clientY, moved: false } : null;
  if (pointers.size === 2) pinch = pinchDistance();
});

canvas.addEventListener("pointermove", (e) => {
  const p = pointers.get(e.pointerId);
  if (!p) return hover(e);
  if (press && Math.hypot(e.clientX - press.x, e.clientY - press.y) > 4) press.moved = true;

  if (pointers.size === 2) {
    p.x = e.clientX;
    p.y = e.clientY;
    const d = pinchDistance();
    const [a, b] = [...pointers.values()];
    const r = canvas.getBoundingClientRect();
    if (pinch) scene.zoomAt(d / pinch, ((a.x + b.x) / 2 - r.left) / scale, ((a.y + b.y) / 2 - r.top) / scale);
    pinch = d;
    return;
  }
  scene.rotateBy((e.clientX - p.x) / scale, (e.clientY - p.y) / scale);
  p.x = e.clientX;
  p.y = e.clientY;
});

const release = (e) => {
  if (!pointers.delete(e.pointerId)) return;
  if (pointers.size === 0) {
    canvas.classList.remove("dragging");
    scene.setDragging(false);
    if (press && !press.moved && e.type === "pointerup") meetups.select(scene.pick(...toFb(e)));
    press = null;
  }
  pinch = 0;
};
canvas.addEventListener("pointerup", release);
canvas.addEventListener("pointercancel", release);
canvas.addEventListener("pointerleave", () => pointers.size || hover(null));

function pinchDistance() {
  const [a, b] = [...pointers.values()];
  return Math.hypot(a.x - b.x, a.y - b.y);
}

canvas.addEventListener(
  "wheel",
  (e) => {
    e.preventDefault();
    const delta = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
    scene.zoomAt(Math.exp(-delta * 0.0018), ...toFb(e));
  },
  { passive: false },
);

canvas.addEventListener("dblclick", (e) => scene.zoomAt(2, ...toFb(e)));

$("zoom-in").addEventListener("click", () => scene.zoomAt(1.6));
$("zoom-out").addEventListener("click", () => scene.zoomAt(1 / 1.6));

window.addEventListener("keydown", (e) => {
  if (e.target instanceof HTMLInputElement || document.querySelector("dialog[open]:modal")) return;
  const step = { ArrowLeft: [-40, 0], ArrowRight: [40, 0], ArrowUp: [0, 40], ArrowDown: [0, -40] }[e.key];
  if (step) {
    e.preventDefault();
    scene.nudge(...step.map((v) => v / scene.zoom));
  } else if (e.key === "+" || e.key === "=") scene.zoomAt(1.6);
  else if (e.key === "-" || e.key === "_") scene.zoomAt(1 / 1.6);
  else if (e.key === "0") scene.zoomAt(1 / 100);
  else if (e.key === "Escape") meetups.select([]);
});

const tip = $("tip");
function hover(e) {
  const ids = e ? scene.pick(...toFb(e)) : [];
  scene.setHighlight({ hover: ids });
  canvas.classList.toggle("pointing", ids.length > 0);
  if (!ids.length) {
    tip.hidden = true;
    return;
  }
  tip.replaceChildren(...ids.slice(0, 3).map((id) => Object.assign(document.createElement("div"), { textContent: meetups.byId(id)?.name ?? "" })));
  if (ids.length > 3) tip.append(Object.assign(document.createElement("div"), { className: "more", textContent: `+${ids.length - 3} more` }));
  tip.hidden = false;
  tip.style.left = `${Math.min(e.clientX + 14, window.innerWidth - tip.offsetWidth - 8)}px`;
  tip.style.top = `${e.clientY + 14}px`;
}

// ----------------------------------------------------------------- meetups

const meetups = createMeetupsUi({
  onFocus: (ids) => {
    scene.setHighlight({ select: ids });
    scene.setAutoRotate(!reducedMotion && ids.length === 0);
  },
  onFly: (m) => scene.flyTo(m.lat, m.lon, 5),
});

async function loadMeetups() {
  try {
    const res = await fetch("api/meetups");
    const data = await res.json();
    meetups.set(data.meetups || []);
    scene.setMarkers(meetups.markers());
  } catch {
    // Keep whatever we had; the next refresh may work.
  }
}
loadMeetups();
setInterval(loadMeetups, 10 * 60 * 1000);

// ------------------------------------------------------------------ stream

const fmt = new Intl.NumberFormat();
let heat = { total: 0, cities: [], min: 3 };

// Pulses queued in a background tab would all fire on return; skip them.
const pulse = (city) => document.hidden || scene.pulse(city);

function applyHeat(data) {
  heat = data;
  scene.setHeat(data.cities);
  $("total").textContent = fmt.format(data.total);
  $("cities").textContent = fmt.format(data.cities.length);
  $("online").textContent = fmt.format(data.online || 0);
  // Joins arrive batched once a minute; spread them out so the globe feels live.
  if (!document.hidden) for (const city of data.joins || []) setTimeout(() => pulse(city), Math.random() * 20_000);
  renderShare();
}

// Connections drop: retry with backoff from 1 s to 60 s, reset only once a
// connection has held for a while, and retry at once when the browser is
// back online. Pings are answered by the edge without waking the server.
const live = { ws: null, attempt: 0, timer: 0 };

function connect() {
  clearTimeout(live.timer);
  const url = new URL("api/live", location.href.replace(/^http/, "ws"));
  if (fromPlugin.sync) url.searchParams.set("sync", fromPlugin.sync);
  const ws = new WebSocket(url);
  live.ws = ws;
  let ping = 0;
  let steady = 0;
  ws.addEventListener("open", () => {
    ping = setInterval(() => ws.send("ping"), 50_000);
    steady = setTimeout(() => (live.attempt = 0), 30_000);
  });
  ws.addEventListener("message", (e) => {
    if (e.data === "pong") return;
    const msg = JSON.parse(e.data);
    if (msg.type === "heat") applyHeat(msg);
    if (msg.type === "sync") followPlugin(msg);
  });
  ws.addEventListener("close", () => {
    clearInterval(ping);
    clearTimeout(steady);
    if (live.ws !== ws) return;
    live.ws = null;
    const delay = Math.min(60_000, 1000 * 2 ** live.attempt++) * (0.5 + Math.random());
    live.timer = setTimeout(connect, delay);
  });
}
connect();
window.addEventListener("online", () => live.ws || connect());

// Cities with omarchy machines online get a beacon now and then.
setInterval(() => {
  const online = heat.onlineCities || [];
  if (online.length) pulse(online[Math.floor(Math.random() * online.length)][0]);
}, 8000);

// ------------------------------------------------------------------- share

function storage(key, value) {
  try {
    if (value === undefined) return localStorage.getItem(key);
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    return null;
  }
}

function clientId() {
  let id = storage(ID_KEY);
  if (!id) {
    id = crypto.randomUUID();
    storage(ID_KEY, id);
  }
  return id;
}

const label = (c) => `${c.name}, ${c.country}`;
const byLabel = new Map(CITIES.map((c) => [label(c).toLowerCase(), c]));
let pluginCity = CITY_BY_ID.get(fromPlugin.city);

// The plugin that opened this page switched theme, city or off.
function followPlugin({ theme, me }) {
  if (theme) themes.follow(theme);
  if (me === undefined) return;
  pluginCity = CITY_BY_ID.get(me);
  try {
    sessionStorage.setItem("omaglobe.plugin", JSON.stringify({ ...fromPlugin, theme: theme || fromPlugin.theme, city: me }));
  } catch {}
  renderShare();
}

$("city-list").append(
  ...[...CITIES].sort((a, b) => a.name.localeCompare(b.name)).map((c) => Object.assign(document.createElement("option"), { value: label(c) })),
);

const sharedCity = () => CITY_BY_ID.get(storage(CITY_KEY));

// One place draws sharing state: the footer button, the panel and "you".
function renderShare() {
  const city = sharedCity();
  const mine = city || pluginCity;
  scene.setSelf(mine?.id);
  const button = $("share-open");
  button.textContent = city ? `[ sharing · ${city.name.toLowerCase()} ]` : pluginCity ? `[ on the map · ${pluginCity.name.toLowerCase()} ]` : "[ share my city ]";
  button.classList.toggle("on", !!mine);

  $("share-toggle").setAttribute("aria-checked", String(!!city));
  const shown = city && heat.cities.some(([id]) => id === city.id);
  $("share-meta").textContent = !city
    ? pluginCity ? `off here · your omarchy bar shares ${pluginCity.name.toLowerCase()}` : "off"
    : shown ? `sharing ${label(city).toLowerCase()}` : `sharing ${label(city).toLowerCase()} · hidden until 3 are here`;
  $("share-summary").textContent = `${fmt.format(heat.total)} on the map · ${fmt.format(heat.online || 0)} online · ${fmt.format(heat.cities.length)} cities`;
}

async function post(path, body) {
  const res = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `request failed (${res.status})`);
  return data;
}

const error = (text) => ($("share-error").textContent = text);

async function share(city) {
  try {
    await post("api/share", { id: clientId(), city: city.id });
    storage(CITY_KEY, city.id);
    $("city-input").value = label(city);
    error("");
    pulse(city.id);
  } catch (err) {
    error(err.message);
  }
  renderShare();
}

async function stop() {
  try {
    await post("api/unshare", { id: clientId() });
    storage(CITY_KEY, null);
    error("");
  } catch (err) {
    error(err.message);
  }
  renderShare();
}

// Snapped to a city right here; the coordinates go nowhere.
function locate() {
  if (!navigator.geolocation) return Promise.reject(new Error("location isn't available here, pick a city"));
  error("locating…");
  return new Promise((resolve, reject) =>
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve(nearestCity(pos.coords.latitude, pos.coords.longitude)),
      () => reject(new Error("couldn't get a location, pick a city")),
      { maximumAge: 3600e3, timeout: 10e3 },
    ),
  ).finally(() => error(""));
}

$("share-open").addEventListener("click", () => {
  const current = sharedCity() || pluginCity;
  $("city-input").value = current ? label(current) : "";
  error("");
  renderShare();
  $("panel").showModal();
});
$("panel").querySelector("[data-close]").addEventListener("click", () => $("panel").close());

$("share-help").addEventListener("click", () => {
  const help = $("share-help-text");
  help.hidden = !help.hidden;
  $("share-help").setAttribute("aria-expanded", String(!help.hidden));
});

$("share-toggle").addEventListener("click", async () => {
  if (sharedCity()) return stop();
  const typed = byLabel.get($("city-input").value.trim().toLowerCase());
  try {
    await share(typed || (await locate()));
  } catch (err) {
    error(err.message);
  }
});

$("city-input").addEventListener("change", () => {
  const city = byLabel.get($("city-input").value.trim().toLowerCase());
  if (city && sharedCity() && city.id !== sharedCity().id) share(city);
});

$("locate").addEventListener("click", async () => {
  try {
    const city = await locate();
    $("city-input").value = label(city);
    if (sharedCity()) share(city);
  } catch (err) {
    error(err.message);
  }
});

// Re-affirm a previous opt-in so the server and this browser agree.
renderShare();
if (sharedCity()) post("api/share", { id: clientId(), city: sharedCity().id }).catch(() => {});

// ----------------------------------------------------------- about, plugin

for (const name of ["about", "plugin"]) {
  const dialog = $(name);
  $(`${name}-open`).addEventListener("click", () => dialog.showModal());
  dialog.querySelector("[data-close]").addEventListener("click", () => dialog.close());
}

$("plugin-copy").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText($("plugin-command").textContent);
    $("plugin-copy").textContent = "[ copied ]";
  } catch {
    getSelection().selectAllChildren($("plugin-command"));
  }
});
