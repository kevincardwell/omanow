
import { CITY_BY_ID } from "../core/cities.js";
import { createScene } from "../core/scene.js";
import { createHistoryUi } from "./days.js";
import { createMeetupsUi, formatDay } from "./meetups.js";
import { createPlaces, emojiSprites } from "./places.js";
import { createThemePicker } from "./themes.js";

const TARGET_FRAMEBUFFER_ROWS = 270;

const $ = (id) => document.getElementById(id);
const canvas = $("globe");
const ctx = canvas.getContext("2d");

const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const scene = createScene({ autoRotate: !reducedMotion });
scene.setSprites(emojiSprites());
const places = createPlaces({ scene });

// The plugin passes its theme, city and sync id in the fragment, which
// browsers never send to the server.
const PLUGIN_KEY = "omanow.plugin";
const fromPlugin = (() => {
  const params = new URLSearchParams(location.hash.slice(1));
  if (location.hash) history.replaceState(null, "", location.pathname + location.search);
  const fresh = { theme: params.get("theme"), city: params.get("me"), sync: params.get("sync") };
  try {
    if (fresh.sync) localStorage.setItem(PLUGIN_KEY, JSON.stringify(fresh));
    const remembered = JSON.parse(localStorage.getItem(PLUGIN_KEY)) || {};
    return { ...remembered, theme: fresh.theme || remembered.theme };
  } catch {
    return fresh;
  }
})();
const themes = createThemePicker({ select: $("theme"), scene, storage, linked: fromPlugin.theme });

let scale = 3;
let image = null;

function resize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  scale = Math.max(2, Math.min(6, Math.round(h / TARGET_FRAMEBUFFER_ROWS)));
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

const toFramebuffer = (e) => {
  const r = canvas.getBoundingClientRect();
  return [(e.clientX - r.left) / scale, (e.clientY - r.top) / scale];
};

const pointers = new Map();
let press = null;
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
    if (press && !press.moved && e.type === "pointerup") select(...toFramebuffer(e));
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
    scene.zoomAt(Math.exp(-delta * 0.0018), ...toFramebuffer(e));
  },
  { passive: false },
);

canvas.addEventListener("dblclick", (e) => scene.zoomAt(2, ...toFramebuffer(e)));

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

function select(sx, sy) {
  const ids = scene.pick(sx, sy);
  const city = scene.pickCity(sx, sy);
  if (!city) {
    places.close();
    meetups.select(ids);
    return;
  }
  const here = ids.map((id) => meetups.byId(id)).filter(Boolean);
  places.open(
    city,
    here.map((m) => ({ label: `${m.name} · ${formatDay(m)}`, open: () => meetups.select([m.id]) })),
    () => meetups.select(ids),
  );
  meetups.select([], places.section);
  requestAnimationFrame(() => keepClear(CITY_BY_ID.get(city)));
}

function keepClear(city) {
  const card = $("meetup-card").getBoundingClientRect();
  const view = canvas.getBoundingClientRect();
  const p = scene.project(city.lat, city.lon);
  const x = view.left + p.sx * scale;
  const y = view.top + p.sy * scale;
  if (x < card.left - 16 || x > card.right + 16 || y < card.top - 100 || y > card.bottom + 16) return;
  const above = card.left < window.innerWidth / 3;
  for (const gap of [110, 80, 50]) {
    const [gx, gy] = above ? [Math.min(Math.max(x, 80), window.innerWidth - 80), card.top - gap] : [card.left - gap, y];
    if (scene.glideTo(city.lat, city.lon, (gx - view.left) / scale, (gy - view.top) / scale)) return;
  }
}

const tip = $("tip");
function hover(e) {
  const at = e ? toFramebuffer(e) : null;
  const ids = at ? scene.pick(...at) : [];
  const city = at && !ids.length ? scene.pickCity(...at) : null;
  scene.setHighlight({ hover: ids });
  canvas.classList.toggle("pointing", ids.length > 0 || city !== null);
  const lines = city ? [places.describe(city)] : ids.slice(0, 3).map((id) => meetups.byId(id)?.name ?? "");
  if (!lines.length) {
    tip.hidden = true;
    return;
  }
  tip.replaceChildren(...lines.map((text) => Object.assign(document.createElement("div"), { textContent: text })));
  if (ids.length > 3) tip.append(Object.assign(document.createElement("div"), { className: "more", textContent: `+${ids.length - 3} more` }));
  tip.hidden = false;
  tip.style.left = `${Math.min(e.clientX + 14, window.innerWidth - tip.offsetWidth - 8)}px`;
  tip.style.top = `${e.clientY + 14}px`;
}

const meetups = createMeetupsUi({
  onFocus: (ids, open) => {
    if (!open || !places.section.isConnected) places.close();
    scene.setHighlight({ select: ids });
    scene.setAutoRotate(!reducedMotion && !open);
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
    // Keep what we had; the next refresh may work.
  }
}
loadMeetups();
setInterval(loadMeetups, 10 * 60 * 1000);

const fmt = new Intl.NumberFormat();
let heat = { total: 0, cities: [], min: 3, today: [], waves: [] };

// Pulses queued in a background tab would all fire at once on return.
const pulse = (city) => document.hidden || scene.pulse(city);

function applyHeat(data) {
  heat = { ...data, today: data.today || data.cities.map(([city]) => city), waves: data.waves || [] };
  scene.setHeat(heat.cities);
  scene.setToday(heat.today);
  $("total").textContent = fmt.format(heat.total);
  $("cities").textContent = fmt.format(heat.today.length);
  $("total-label").textContent = heat.total === 1 ? "omarchy machine" : "omarchy machines";
  $("cities-label").textContent = heat.today.length === 1 ? "city" : "cities";
  // Joins arrive batched; spread them out.
  if (!document.hidden) for (const city of data.joins || []) setTimeout(() => pulse(city), Math.random() * 20_000);
  places.setHeat(heat);
  renderYou();
}

// Backoff from 1 s to 60 s resets only after a connection has held for 30 s,
// so a server that accepts and drops can't cause a tight loop. Pings are
// answered by the edge without waking the Durable Object.
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
    if (msg.type === "wave") places.received(msg);
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

setInterval(() => {
  if (heat.today.length) pulse(heat.today[Math.floor(Math.random() * heat.today.length)]);
}, 8000);

function storage(key, value) {
  try {
    if (value === undefined) return localStorage.getItem(key);
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    return null;
  }
}

let pluginCity = CITY_BY_ID.get(fromPlugin.city);

function followPlugin({ theme, me }) {
  if (theme) themes.follow(theme);
  if (me === undefined) return;
  pluginCity = CITY_BY_ID.get(me);
  Object.assign(fromPlugin, { theme: theme || fromPlugin.theme, city: me });
  storage(PLUGIN_KEY, JSON.stringify(fromPlugin));
  renderYou();
}

function renderYou() {
  scene.setSelf(pluginCity?.id);
  places.setMe(pluginCity?.id);
  const button = $("share-open");
  button.textContent = pluginCity ? `[ joined · ${pluginCity.name.toLowerCase()} ]` : "[ join ]";
  button.classList.toggle("on", !!pluginCity);
}
renderYou();

for (const name of ["about", "plugin"]) {
  const dialog = $(name);
  $(`${name}-open`).addEventListener("click", () => dialog.showModal());
  dialog.querySelector("[data-close]").addEventListener("click", () => dialog.close());
}
$("share-open").addEventListener("click", () => $("plugin").showModal());
createHistoryUi();

$("plugin-copy").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText($("plugin-command").textContent.trim().split("\n").join(" && "));
    $("plugin-copy").textContent = "[ copied ]";
  } catch {
    getSelection().selectAllChildren($("plugin-command"));
  }
});
