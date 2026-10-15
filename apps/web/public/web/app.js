// Web host for the omaglobe scene: owns the canvas, clock, input, network
// and the opt-in UI. Everything visual lives in ../core so another host
// (e.g. an Omarchy shell plugin) can drive the same scene.

import { CITIES, CITY_BY_ID, nearestCity } from "../core/cities.js";
import { createScene } from "../core/scene.js";
import { createMeetupsUi } from "./meetups.js";

const TARGET_ROWS = 270; // framebuffer height the pixel scale aims for
const ID_KEY = "omaglobe.id";
const CITY_KEY = "omaglobe.city";

const $ = (id) => document.getElementById(id);
const canvas = $("globe");
const ctx = canvas.getContext("2d");

const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const scene = createScene({ autoRotate: !reducedMotion });

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

function applyHeat(data) {
  heat = data;
  scene.setHeat(data.cities);
  $("total").textContent = fmt.format(data.total);
  $("cities").textContent = fmt.format(data.cities.length);
  // Joins arrive batched once a minute; spread them out so the globe feels live.
  for (const city of data.joins || []) setTimeout(() => scene.pulse(city), Math.random() * 20_000);
  showSharing(storage(CITY_KEY));
}

// Pings are answered by the edge without waking the server; they keep idle
// proxies from dropping the socket.
function connect(attempt = 0) {
  const ws = new WebSocket(new URL("api/live", location.href.replace(/^http/, "ws")));
  let ping = 0;
  ws.addEventListener("open", () => {
    attempt = 0;
    ping = setInterval(() => ws.send("ping"), 50_000);
  });
  ws.addEventListener("message", (e) => {
    if (e.data === "pong") return;
    const msg = JSON.parse(e.data);
    if (msg.type === "heat") applyHeat(msg);
  });
  ws.addEventListener("close", () => {
    clearInterval(ping);
    const delay = Math.min(60_000, 1000 * 2 ** attempt) * (0.5 + Math.random());
    setTimeout(() => connect(attempt + 1), delay);
  });
}
connect();

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

$("city-list").append(
  ...[...CITIES].sort((a, b) => a.name.localeCompare(b.name)).map((c) => Object.assign(document.createElement("option"), { value: label(c) })),
);

function showSharing(cityId) {
  const city = cityId && CITY_BY_ID.get(cityId);
  $("share-open").hidden = !!city;
  $("sharing").hidden = !city;
  if (!city) return;
  $("sharing-city").textContent = label(city);
  const shown = heat.cities.some(([id]) => id === city.id);
  $("sharing-note").textContent = shown ? "" : `· shows once ${heat.min}+ people share it`;
}

async function post(path, body) {
  const res = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `request failed (${res.status})`);
  return data;
}

function openPanel() {
  const current = CITY_BY_ID.get(storage(CITY_KEY));
  $("city-input").value = current ? label(current) : "";
  $("share-error").textContent = "";
  $("panel").showModal();
  $("city-input").focus();
}

$("share-open").addEventListener("click", openPanel);
$("share-change").addEventListener("click", openPanel);

$("share-stop").addEventListener("click", async () => {
  try {
    await post("api/unshare", { id: clientId() });
    storage(CITY_KEY, null);
    showSharing(null);
  } catch (err) {
    alert(`Could not stop sharing: ${err.message}`);
  }
});

$("locate").addEventListener("click", () => {
  const err = $("share-error");
  if (!navigator.geolocation) {
    err.textContent = "geolocation isn't available here, pick a city instead";
    return;
  }
  err.textContent = "locating…";
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      // Snapped locally; the coordinates are dropped right here.
      const city = nearestCity(pos.coords.latitude, pos.coords.longitude);
      $("city-input").value = label(city);
      err.textContent = "";
    },
    () => (err.textContent = "couldn't get a location, pick a city instead"),
    { maximumAge: 3600e3, timeout: 10e3 },
  );
});

$("share-form").addEventListener("submit", async (e) => {
  if (e.submitter?.value !== "share") return;
  e.preventDefault();
  const city = byLabel.get($("city-input").value.trim().toLowerCase());
  if (!city) {
    $("share-error").textContent = "pick a city from the list";
    return;
  }
  try {
    await post("api/share", { id: clientId(), city: city.id });
    storage(CITY_KEY, city.id);
    showSharing(city.id);
    scene.pulse(city.id);
    $("panel").close();
  } catch (err) {
    $("share-error").textContent = err.message;
  }
});

// Re-affirm a previous opt-in so the server and this browser agree.
const saved = storage(CITY_KEY);
showSharing(saved);
if (CITY_BY_ID.has(saved)) post("api/share", { id: clientId(), city: saved }).catch(() => {});
