// Renders the whole view into an RGBA framebuffer. No DOM, timers or atob:
// the host owns the clock, input and blitting.

import { CITIES, CITY_BY_ID, nearestCity } from "./cities.js";
import { drawMicro, foldLabel, layoutText, MICRO_H, microWidth } from "./font.js";
import { LAND, LAND_H, LAND_W } from "./land.js";
import { resolveTheme } from "./theme.js";

const DEG = Math.PI / 180;
const TAU = Math.PI * 2;

const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => (v + 0.5) / 16);
const bayer = (x, y) => BAYER[((y & 3) << 2) | (x & 3)];

const HEAT_W = 360;
const HEAT_H = 180;
const MAX_PARTICLES = 400;
const MAX_BEACONS = 28;
const MAX_RINGS = 24;
const MAX_PARTICLES_PER_SECOND = 30;
const MAX_PITCH = 75 * DEG;
const MIN_ZOOM = 1;
const MAX_ZOOM = 12;
const LABEL_ZOOM = 1.6;
const ALL_CITIES_ZOOM = 2.6;
const PICK_RADIUS = 6;

// Colors are [r, g, b]; pixels are packed little-endian ABGR, so a Uint32Array
// over the RGBA byte buffer writes them in one store.

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const pack = (c) => (255 << 24) | (Math.round(c[2]) << 16) | (Math.round(c[1]) << 8) | Math.round(c[0]);

function buildPalette(theme) {
  const t = Object.fromEntries(Object.entries(theme).map(([k, v]) => [k, hexToRgb(v)]));
  const space = t.darker_background;
  const ocean = [
    mix(space, t.blue, 0.05),
    mix(t.dark_background, t.blue, 0.1),
    mix(t.background, t.blue, 0.16),
    mix(t.lighter_background, t.blue, 0.22),
  ];
  const land = [
    mix(t.dark_background, t.muted, 0.8),
    mix(t.muted, t.accent, 0.25),
    mix(t.muted, t.accent, 0.6),
    mix(t.accent, t.bright_foreground, 0.35),
  ];
  const heat = [
    mix(t.magenta, space, 0.35),
    t.magenta,
    t.bright_magenta ? mix(t.magenta, t.red, 0.5) : t.magenta,
    t.red,
    t.orange,
    t.yellow,
    mix(t.yellow, [255, 255, 255], 0.55),
  ];
  return {
    raw: t,
    space: pack(space),
    spaceRgb: space,
    vignette: pack(mix(space, [0, 0, 0], 0.45)),
    ocean: ocean.map(pack),
    land: land.map(pack),
    grid: pack(mix(ocean[1], t.accent, 0.22)),
    rim: [pack(mix(space, t.accent, 0.25)), pack(mix(space, t.accent, 0.5)), pack(mix(t.accent, t.bright_foreground, 0.2))],
    heat: heat.map(pack),
    heatRgb: heat,
    star: [pack(mix(space, t.dark_foreground, 0.6)), pack(t.dark_foreground), pack(t.foreground), pack(t.bright_foreground)],
    logoShadow: pack(mix(space, t.accent, 0.12)),
    label: pack(t.foreground),
    labelDim: pack(mix(t.dark_foreground, t.foreground, 0.2)),
    labelCount: pack(t.yellow),
    labelShadow: pack(mix(space, [0, 0, 0], 0.3)),
    cityDot: pack(t.dark_foreground),
    meetup: pack(t.green),
    meetupCore: pack(mix(t.green, [255, 255, 255], 0.55)),
    meetupRing: pack(mix(t.green, space, 0.35)),
    meetupPast: pack(mix(t.dark_foreground, space, 0.15)),
    focus: pack(t.yellow),
    self: pack(t.bright_foreground),
    selfShadow: pack(mix(space, [0, 0, 0], 0.6)),
    logoBase: [mix(t.dark_foreground, t.muted, 0.4), t.foreground, t.bright_foreground],
    logoHot: heat,
  };
}

function seededRandom(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let r = Math.imul(s ^ (s >>> 15), 1 | s);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

export function createScene(options = {}) {
  let palette = buildPalette(resolveTheme(options.theme));
  const random = options.random || Math.random;

  let W = 0;
  let H = 0;
  let pixels = new Uint8ClampedArray(0);
  let buf = new Uint32Array(0);
  let background = new Uint32Array(0);
  let stars = [];

  let cx = 0;
  let cy = 0;
  let R = 0;
  // The longitude and latitude facing the viewer, in radians.
  let yaw = -10 * DEG;
  let pitch = 25 * DEG;
  let velYaw = 0;
  let velPitch = 0;
  let dragging = false;
  let idle = 10;
  let autoRotate = options.autoRotate ?? true;
  let zoom = 1;
  let zoomTarget = 1;
  let radiusPx = 0;
  let zoomAnchor = null;
  let flight = null;

  const logoText = layoutText("OMAGLOBE");
  let logoScale = 2;
  let logoX = 0;
  let logoY = 0;
  const logoCharge = new Float32Array(logoText.cells.length);
  const logoNeighbors = logoText.cells.map((a) =>
    logoText.cells.flatMap((b, j) => (Math.abs(a.x - b.x) + Math.abs(a.y - b.y) === 1 ? [j] : [])),
  );

  let heatField = new Float32Array(HEAT_W * HEAT_H);
  let active = [];
  let energy = 0;
  let particles = [];
  let embers = [];
  let rings = [];
  let self = null;
  let time = 0;

  let markers = [];
  let shownLabels = new Map();
  let hovered = new Set();
  let selected = new Set();
  const cityLabels = new Map(CITIES.map((c) => [c.id, foldLabel(c.name)]));
  const citiesByWeight = [...CITIES].sort((a, b) => b.weight - a.weight);

  function resize(width, height) {
    W = Math.max(64, width | 0);
    H = Math.max(64, height | 0);
    pixels = new Uint8ClampedArray(W * H * 4);
    buf = new Uint32Array(pixels.buffer);

    logoScale = W >= 380 ? 3 : 2;
    const logoW = logoText.width * logoScale;
    logoX = Math.floor((W - logoW) / 2);
    logoY = Math.max(6, Math.floor(H * 0.05));
    const logoBottom = logoY + logoText.height * logoScale;

    const avail = H - logoBottom - 14;
    R = Math.floor(Math.min(avail / 2 - 8, W * 0.42));
    cx = Math.floor(W / 2);
    cy = Math.floor(logoBottom + 14 + avail / 2 + 2);
    radiusPx = R * zoom;

    buildBackground();
    particles = [];
    embers = [];
  }

  function buildBackground() {
    background = new Uint32Array(W * H);
    const r2 = (W * W + H * H) / 4;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const dx = x - W / 2;
        const dy = y - H / 2;
        const cornerness = (dx * dx + dy * dy) / r2;
        background[y * W + x] = cornerness * 1.6 - 0.75 > bayer(x, y) ? palette.vignette : palette.space;
      }
    }
    const r = seededRandom(0xc0ffee);
    const count = Math.floor((W * H) / 260);
    stars = [];
    for (let i = 0; i < count; i++) {
      stars.push({ x: Math.floor(r() * W), y: Math.floor(r() * H), level: r() < 0.85 ? 0 : 1, phase: r() * TAU, speed: 0.4 + r() * 1.6 });
    }
  }

  // Counts as [cityId, count] pairs or { id, count } objects.
  function setHeat(counts) {
    const list = [];
    let max = 0;
    let total = 0;
    for (const entry of counts) {
      const id = Array.isArray(entry) ? entry[0] : entry.id;
      const count = Array.isArray(entry) ? entry[1] : entry.count;
      const city = CITY_BY_ID.get(id);
      if (!city || !(count > 0)) continue;
      list.push({ city, count });
      max = Math.max(max, count);
      total += count;
    }
    const prev = new Map(active.map((a) => [a.city.id, a.emitAcc]));
    const logMax = Math.log2(1 + max) || 1;
    active = list
      .map(({ city, count }) => ({ city, count, norm: Math.log2(1 + count) / logMax, emitAcc: prev.get(city.id) ?? random(), rate: 0, beacon: false }))
      .sort((a, b) => b.count - a.count);
    let sum = 0;
    for (const a of active) sum += a.rate = 0.08 + 1.6 * a.norm ** 2;
    const k = sum > MAX_PARTICLES_PER_SECOND ? MAX_PARTICLES_PER_SECOND / sum : 1;
    for (const a of active) a.rate *= k;
    for (let i = 0; i < Math.min(MAX_BEACONS, active.length); i++) active[i].beacon = true;
    energy = Math.min(1, Math.log10(1 + total) / 3);
    buildHeatField();
  }

  function buildHeatField() {
    heatField = new Float32Array(HEAT_W * HEAT_H);
    const cellDeg = 360 / HEAT_W;
    for (const { city, norm } of active) {
      const sigmaDeg = 1.1 + 2.1 * norm;
      const reach = sigmaDeg * 3;
      const amp = 0.3 + 0.7 * norm * norm;
      const cosLat = Math.max(0.2, Math.cos(city.lat * DEG));
      const rowMin = Math.max(0, Math.floor((90 - city.lat - reach) / cellDeg));
      const rowMax = Math.min(HEAT_H - 1, Math.ceil((90 - city.lat + reach) / cellDeg));
      const colSpan = Math.ceil(reach / cosLat / cellDeg);
      const col0 = Math.floor((city.lon + 180) / cellDeg);
      for (let row = rowMin; row <= rowMax; row++) {
        const lat = 90 - (row + 0.5) * cellDeg;
        const dLat = lat - city.lat;
        for (let dc = -colSpan; dc <= colSpan; dc++) {
          const col = (((col0 + dc) % HEAT_W) + HEAT_W) % HEAT_W;
          const lon = -180 + (col0 + dc + 0.5) * cellDeg;
          const dLon = (lon - city.lon) * cosLat;
          const d2 = dLat * dLat + dLon * dLon;
          if (d2 > reach * reach) continue;
          const i = row * HEAT_W + col;
          heatField[i] = 1 - (1 - heatField[i]) * (1 - amp * Math.exp(-d2 / (2 * sigmaDeg * sigmaDeg)));
        }
      }
    }
  }

  // A shockwave at the city and a burst of particles into the logo.
  function pulse(cityId) {
    const city = CITY_BY_ID.get(cityId);
    if (!city || rings.length >= MAX_RINGS) return;
    rings.push({ city, age: 0 });
    const p = project(city.lat, city.lon);
    if (p.z > 0.05 && onScreen(p)) for (let i = 0; i < 14; i++) spawnParticle(p.sx, p.sy, 1, i * 0.035);
  }

  // [{ id, lat, lon, upcoming, label }]; labels are drawn as plain text.
  function setMarkers(list) {
    markers = list
      .filter((m) => Number.isFinite(m.lat) && Number.isFinite(m.lon))
      .map((m) => {
        // Meetups in a catalogue city share that city's label.
        const near = nearestCity(m.lat, m.lon);
        const km = near ? 111 * Math.hypot(near.lat - m.lat, (near.lon - m.lon) * Math.cos(m.lat * DEG)) : Infinity;
        const same = km < 20;
        return { id: m.id, lat: m.lat, lon: m.lon, upcoming: !!m.upcoming, label: foldLabel(m.label || ""), cityId: same ? near.id : null, phase: random() * TAU };
      });
  }

  // The viewer's own city, drawn whether or not it is on the public map.
  function setSelf(cityId) {
    self = CITY_BY_ID.get(cityId) || null;
  }

  function setHighlight({ hover, select } = {}) {
    if (hover) hovered = new Set(hover);
    if (select) selected = new Set(select);
  }

  // Meetups under a framebuffer point, nearest first.
  function pick(sx, sy) {
    const hits = [];
    for (const m of markers) {
      const p = project(m.lat, m.lon);
      if (p.z < 0.08) continue;
      const d = Math.hypot(p.sx - sx, p.sy - (sy + 2));
      if (d <= PICK_RADIUS) hits.push({ id: m.id, d });
    }
    return hits.sort((a, b) => a.d - b.d).map((h) => h.id);
  }

  function rotateBy(dx, dy) {
    const k = 1 / Math.max(1, radiusPx);
    yaw -= dx * k;
    pitch = clamp(pitch + dy * k, -MAX_PITCH, MAX_PITCH);
    velYaw = -dx * k * 60;
    velPitch = dy * k * 60;
    idle = 0;
  }

  function setDragging(on) {
    dragging = on;
    idle = 0;
    if (on) {
      velYaw = velPitch = 0;
      zoomAnchor = null;
      flight = null;
    }
  }

  // Zoom by `factor`, keeping the globe point under (sx, sy) in place.
  function zoomAt(factor, sx = cx, sy = cy) {
    zoomTarget = clamp(zoomTarget * factor, MIN_ZOOM, MAX_ZOOM);
    const hit = unproject(sx, sy);
    zoomAnchor = hit ? { lat: hit.lat, lon: hit.lon, sx, sy } : null;
    flight = null;
    idle = 0;
  }

  // Animate so (lat, lon) ends up centered at `toZoom`.
  function flyTo(lat, lon, toZoom = Math.max(zoomTarget, 4)) {
    let toYaw = lon * DEG;
    while (toYaw - yaw > Math.PI) toYaw -= TAU;
    while (toYaw - yaw < -Math.PI) toYaw += TAU;
    const dist = Math.acos(clamp(Math.sin(pitch) * Math.sin(lat * DEG) + Math.cos(pitch) * Math.cos(lat * DEG) * Math.cos(toYaw - yaw), -1, 1));
    flight = {
      from: { yaw, pitch, zoom },
      to: { yaw: toYaw, pitch: clamp(lat * DEG, -MAX_PITCH, MAX_PITCH), zoom: clamp(toZoom, MIN_ZOOM, MAX_ZOOM) },
      t: 0,
      dur: 0.8 + dist * 0.6,
      dip: Math.min(0.6, dist / 2),
    };
    zoomAnchor = null;
    velYaw = velPitch = 0;
    idle = 0;
  }

  function setView(lat, lon, toZoom = zoom) {
    yaw = lon * DEG;
    pitch = clamp(lat * DEG, -MAX_PITCH, MAX_PITCH);
    zoom = zoomTarget = clamp(toZoom, MIN_ZOOM, MAX_ZOOM);
    radiusPx = R * zoom;
    flight = null;
    zoomAnchor = null;
    velYaw = velPitch = 0;
  }

  function nudge(dYawDeg, dPitchDeg) {
    velYaw += dYawDeg * DEG;
    velPitch += dPitchDeg * DEG;
    idle = 0;
  }

  function project(latDeg, lonDeg, lift = 1) {
    const lat = latDeg * DEG;
    const dl = lonDeg * DEG - yaw;
    const X = Math.cos(lat) * Math.sin(dl);
    const Y = Math.sin(lat);
    const Z = Math.cos(lat) * Math.cos(dl);
    const cp = Math.cos(pitch);
    const sp = Math.sin(pitch);
    const x = X * lift;
    const y = (Y * cp - Z * sp) * lift;
    const z = (Y * sp + Z * cp) * lift;
    return { x, y, z, sx: cx + x * radiusPx, sy: cy - y * radiusPx };
  }

  // Framebuffer point -> { lat, lon } in degrees, or null off the globe.
  function unproject(sx, sy) {
    const x = (sx - cx) / radiusPx;
    const y = (cy - sy) / radiusPx;
    const r2 = x * x + y * y;
    if (r2 >= 1) return null;
    const z = Math.sqrt(1 - r2);
    const cp = Math.cos(pitch);
    const sp = Math.sin(pitch);
    const Y = y * cp + z * sp;
    const Z = -y * sp + z * cp;
    let lon = Math.atan2(x, Z) + yaw;
    lon = ((lon + Math.PI) % TAU + TAU) % TAU - Math.PI;
    return { lat: Math.asin(clamp(Y, -1, 1)) / DEG, lon: lon / DEG };
  }

  // Solve yaw/pitch so that (lat, lon) projects to (sx, sy) at the current
  // zoom. Returns false when that isn't reachable (then we just zoom).
  function orient(latDeg, lonDeg, sx, sy) {
    const x = (sx - cx) / radiusPx;
    const y = (cy - sy) / radiusPx;
    const lat = latDeg * DEG;
    const cosLat = Math.cos(lat);
    if (x * x + y * y >= 1 || Math.abs(x) >= cosLat) return false;
    const dl = Math.asin(x / cosLat);
    const Y = Math.sin(lat);
    const Z = cosLat * Math.cos(dl);
    const A = Math.hypot(Y, Z);
    if (Math.abs(y) >= A) return false;
    let p = Math.acos(y / A) - Math.atan2(Z, Y);
    p = ((p + Math.PI) % TAU + TAU) % TAU - Math.PI;
    if (Math.abs(p) > MAX_PITCH) return false;
    pitch = p;
    yaw = lonDeg * DEG - dl;
    return true;
  }

  const onScreen = (p) => p.sx >= 0 && p.sy >= 0 && p.sx < W && p.sy < H;

  function spawnParticle(sx, sy, norm, delay = 0) {
    if (particles.length >= MAX_PARTICLES) return;
    const cell = logoText.cells[Math.floor(random() * logoText.cells.length)];
    const cellIndex = logoText.cells.indexOf(cell);
    const tx = logoX + cell.x * logoScale + logoScale / 2;
    const ty = logoY + cell.y * logoScale + logoScale / 2;
    const out = sx < cx ? -1 : 1;
    const c1x = sx + out * (20 + random() * 40);
    const c1y = sy - 10 - random() * 30;
    const c2x = tx + out * (10 + random() * 50);
    const c2y = ty + 30 + random() * 40;
    particles.push({
      p: [sx, sy, c1x, c1y, c2x, c2y, tx, ty],
      t: -delay,
      dur: 1.3 + random() * 1.2,
      cellIndex,
      color: Math.min(palette.heat.length - 1, 2 + Math.round(norm * (palette.heat.length - 3))),
    });
  }

  function bezier(p, u) {
    const v = 1 - u;
    const a = v * v * v;
    const b = 3 * v * v * u;
    const c = 3 * v * u * u;
    const d = u * u * u;
    return [a * p[0] + b * p[2] + c * p[4] + d * p[6], a * p[1] + b * p[3] + c * p[5] + d * p[7]];
  }

  function update(dt) {
    time += dt;
    idle += dt;

    if (flight) {
      flight.t = Math.min(1, flight.t + dt / flight.dur);
      const e = flight.t * flight.t * (3 - 2 * flight.t);
      const { from, to } = flight;
      yaw = from.yaw + (to.yaw - from.yaw) * e;
      pitch = from.pitch + (to.pitch - from.pitch) * e;
      zoom = Math.exp(Math.log(from.zoom) + (Math.log(to.zoom) - Math.log(from.zoom)) * e) * (1 - flight.dip * Math.sin(Math.PI * e));
      zoom = Math.max(MIN_ZOOM, zoom);
      zoomTarget = to.zoom;
      radiusPx = R * zoom;
      if (flight.t >= 1) flight = null;
    } else if (zoom !== zoomTarget) {
      zoom += (zoomTarget - zoom) * (1 - Math.exp(-dt * 14));
      if (Math.abs(zoom - zoomTarget) < 1e-3) zoom = zoomTarget;
      radiusPx = R * zoom;
      if (zoomAnchor && !orient(zoomAnchor.lat, zoomAnchor.lon, zoomAnchor.sx, zoomAnchor.sy)) zoomAnchor = null;
    } else {
      zoomAnchor = null;
    }

    if (!dragging && !flight) {
      const damp = Math.exp(-dt * 2.5);
      velYaw *= damp;
      velPitch *= damp;
      if (autoRotate && idle > 1.5 && zoomTarget < 1.3) {
        const ramp = Math.min(1, (idle - 1.5) / 2);
        yaw += dt * 0.12 * ramp;
        pitch += (22 * DEG - pitch) * dt * 0.15 * ramp;
      }
      yaw += velYaw * dt;
      pitch = clamp(pitch + velPitch * dt, -MAX_PITCH, MAX_PITCH);
    }
    yaw = ((yaw + Math.PI) % TAU + TAU) % TAU - Math.PI;

    for (const a of active) {
      a.emitAcc += dt * a.rate;
      if (a.emitAcc < 1) continue;
      a.emitAcc -= 1;
      const p = project(a.city.lat, a.city.lon);
      if (p.z > 0.12 && onScreen(p)) spawnParticle(p.sx, p.sy, a.norm);
    }

    for (const pt of particles) {
      pt.t += dt / pt.dur;
      if (pt.t >= 1) {
        logoCharge[pt.cellIndex] = 1;
        for (const n of logoNeighbors[pt.cellIndex]) logoCharge[n] = Math.max(logoCharge[n], 0.55);
        if (random() < 0.4) {
          const cell = logoText.cells[pt.cellIndex];
          embers.push({ x: logoX + cell.x * logoScale + random() * logoScale, y: logoY + cell.y * logoScale, vy: -(6 + random() * 10), life: 1, color: pt.color });
        }
      }
    }
    particles = particles.filter((p) => p.t < 1);

    const decay = Math.exp(-dt * 0.9);
    for (let i = 0; i < logoCharge.length; i++) logoCharge[i] *= decay;

    for (const e of embers) {
      e.y += e.vy * dt;
      e.life -= dt * 0.9;
    }
    embers = embers.filter((e) => e.life > 0);

    for (const r of rings) r.age += dt;
    rings = rings.filter((r) => r.age < 1.6);
  }

  function put(x, y, color) {
    x |= 0;
    y |= 0;
    if (x >= 0 && y >= 0 && x < W && y < H) buf[y * W + x] = color;
  }

  function renderStars() {
    for (const s of stars) {
      const tw = Math.sin(time * s.speed + s.phase);
      const lvl = s.level + (tw > 0.75 ? 2 : tw > 0.2 ? 1 : 0);
      if (tw < -0.6) continue;
      put(s.x, s.y, palette.star[Math.min(3, lvl)]);
    }
  }

  function renderGlobe() {
    const cp = Math.cos(pitch);
    const sp = Math.sin(pitch);
    const rim = Math.max(3, Math.round(R * 0.07));
    const invR = 1 / radiusPx;
    const lx = -0.45;
    const ly = 0.55;
    const lz = 0.7;
    const heatShimmer = time * 2.2;
    const heatGain = Math.min(1, 1.2 / Math.sqrt(zoom));
    const gridWidthDeg = 0.6 / zoom;
    const heatLevels = palette.heat.length;

    const y0 = Math.max(0, Math.floor(cy - radiusPx - rim));
    const y1 = Math.min(H - 1, Math.ceil(cy + radiusPx + rim));
    const x0 = Math.max(0, Math.floor(cx - radiusPx - rim));
    const x1 = Math.min(W - 1, Math.ceil(cx + radiusPx + rim));

    for (let py = y0; py <= y1; py++) {
      const y = (cy - py - 0.5) * invR;
      for (let px = x0; px <= x1; px++) {
        const x = (px + 0.5 - cx) * invR;
        const r2 = x * x + y * y;
        const d = bayer(px, py);

        if (r2 > 1) {
          const r = Math.sqrt(r2);
          const fall = 1 - ((r - 1) * radiusPx) / rim;
          if (fall <= 0) continue;
          const lit = 0.55 + 0.45 * ((x * lx + y * ly) / r);
          const v = fall * fall * lit * 2.6;
          if (v > d) buf[py * W + px] = palette.rim[Math.min(2, Math.floor(v - d + 0.4))];
          continue;
        }

        const z = Math.sqrt(1 - r2);
        const Y = y * cp + z * sp;
        const Z = -y * sp + z * cp;
        const lat = Math.asin(Y);
        let lon = Math.atan2(x, Z) + yaw;
        if (lon > Math.PI) lon -= TAU;
        else if (lon < -Math.PI) lon += TAU;

        const u = (lon + Math.PI) / TAU;
        const v = (Math.PI / 2 - lat) / Math.PI;
        const land = LAND[Math.min(LAND_H - 1, (v * LAND_H) | 0) * LAND_W + Math.min(LAND_W - 1, (u * LAND_W) | 0)];

        const diffuse = Math.max(0, x * lx + y * ly + z * lz);
        const shade = Math.min(3, Math.max(0, Math.floor(diffuse * 3.4 + d - 0.3)));
        let color = land ? palette.land[shade] : palette.ocean[shade];

        if (!land && ((px + py) & 1) === 0) {
          const latD = lat / DEG;
          const lonD = lon / DEG;
          const gLat = Math.abs(latD - Math.round(latD / 15) * 15);
          const gLon = Math.abs(lonD - Math.round(lonD / 15) * 15) * Math.cos(lat);
          if (gLat < gridWidthDeg || gLon < gridWidthDeg) color = palette.grid;
        }

        const hi = Math.min(HEAT_H - 1, (v * HEAT_H) | 0) * HEAT_W + Math.min(HEAT_W - 1, (u * HEAT_W) | 0);
        const h = heatField[hi] * heatGain;
        if (h > 0.02) {
          const hv = h * (0.88 + 0.12 * Math.sin(heatShimmer + hi * 0.37)) * heatLevels + (d - 0.5) * 1.4 - 0.4;
          if (hv >= 1) color = palette.heat[Math.min(heatLevels - 1, (hv | 0) - 1)];
        }

        buf[py * W + px] = color;
      }
    }
  }

  function renderBeacons() {
    const heatLevels = palette.heat.length;
    for (const a of active) {
      if (!a.beacon) continue;
      const base = project(a.city.lat, a.city.lon);
      if (base.z < 0.02) continue;
      const hPx = (0.03 + 0.14 * a.norm * a.norm) * R;
      const h = hPx / radiusPx;
      const steps = Math.max(2, Math.ceil(hPx * 1.2));
      for (let s = 0; s <= steps; s++) {
        const lift = 1 + (h * s) / steps;
        const x = base.x * lift;
        const y = base.y * lift;
        const z = base.z * lift;
        if (z < 0 && x * x + y * y < 1) continue;
        const k = s / steps;
        const lvl = Math.min(heatLevels - 1, Math.floor(2 + k * (heatLevels - 2) * (0.5 + 0.5 * a.norm)));
        put(cx + x * radiusPx, cy - y * radiusPx, palette.heat[lvl]);
      }
      const blink = Math.sin(time * 4 + a.city.lat) > 0.3;
      if (blink) {
        const tip = 1 + h;
        const tx = base.x * tip;
        const ty = base.y * tip;
        if (!(base.z < 0 && tx * tx + ty * ty < 1)) {
          put(cx + tx * radiusPx, cy - ty * radiusPx - 1, palette.heat[heatLevels - 1]);
        }
      }
    }
  }

  function renderRings() {
    for (const r of rings) {
      const p = project(r.city.lat, r.city.lon);
      if (p.z < 0.05) continue;
      const radius = 2 + r.age * 22;
      const n = Math.ceil(radius * TAU);
      const skip = r.age > 0.8 ? 2 : 1;
      const color = palette.heat[Math.max(1, palette.heat.length - 1 - Math.floor(r.age * 3))];
      for (let i = 0; i < n; i += skip) {
        const a = (i / n) * TAU;
        put(p.sx + Math.cos(a) * radius, p.sy + Math.sin(a) * radius * Math.max(0.35, p.z), color);
      }
    }
  }

  function renderParticles() {
    for (const pt of particles) {
      if (pt.t < 0) continue;
      const trail = 14;
      for (let i = trail; i >= 1; i--) {
        const tt = pt.t - i * 0.014;
        if (tt < 0) continue;
        const e = tt * tt * (3 - 2 * tt);
        const [x, y] = bezier(pt.p, e);
        if (i > trail / 2 && ((x | 0) + (y | 0)) & 1) continue;
        const lvl = Math.max(0, pt.color - Math.floor((i * pt.color) / trail));
        put(x, y, palette.heat[lvl]);
      }
      const e = pt.t * pt.t * (3 - 2 * pt.t);
      const [hx, hy] = bezier(pt.p, e);
      const top = palette.heat[palette.heat.length - 1];
      put(hx, hy, top);
      put(hx + 1, hy, top);
      put(hx, hy + 1, palette.heat[pt.color]);
      put(hx + 1, hy + 1, palette.heat[pt.color]);
    }
  }

  function renderLogo() {
    const s = logoScale;
    const cells = logoText.cells;
    const hot = palette.logoHot;
    const sweep = ((time * 0.35) % 1.6) * (logoText.width + logoText.height * 2) - logoText.height;

    for (let i = 0; i < cells.length; i++) {
      const c = cells[i];
      const ox = logoX + c.x * s;
      const oy = logoY + c.y * s;
      for (let yy = 0; yy < s; yy++) for (let xx = 0; xx < s; xx++) put(ox + xx + 1, oy + yy + 1, palette.logoShadow);
    }

    for (let i = 0; i < cells.length; i++) {
      const c = cells[i];
      const ox = logoX + c.x * s;
      const oy = logoY + c.y * s;
      const band = Math.abs(c.x + c.y * 0.6 - sweep) < 1.2 ? 0.35 : 0;
      const t = Math.min(1, 0.25 + energy * 0.55 + band - c.y * 0.03);
      const base = t < 0.5 ? mix(palette.logoBase[0], palette.logoBase[1], t * 2) : mix(palette.logoBase[1], palette.logoBase[2], (t - 0.5) * 2);
      const q = logoCharge[i];
      for (let yy = 0; yy < s; yy++) {
        for (let xx = 0; xx < s; xx++) {
          const px = ox + xx;
          const py = oy + yy;
          const d = bayer(px, py);
          let rgb = base;
          if (q > 0.04) {
            const hv = q * (hot.length - 1) + (d - 0.5);
            const lvl = Math.max(0, Math.min(hot.length - 1, Math.round(hv)));
            rgb = mix(base, hot[lvl], Math.min(1, q * 1.6));
          }
          put(px, py, pack(rgb));
        }
      }
    }

    for (const e of embers) {
      const lvl = Math.max(0, Math.min(palette.heat.length - 1, Math.round(e.color * e.life)));
      if (e.life < 0.35 && ((e.x | 0) + (e.y | 0)) & 1) continue;
      put(e.x, e.y, palette.heat[lvl]);
    }
  }

  function renderMarkers() {
    // Past meetups first so upcoming pins draw on top.
    const order = [...markers].sort((a, b) => a.upcoming - b.upcoming);
    for (const m of order) {
      const p = project(m.lat, m.lon);
      if (p.z < 0.08 || !onScreen(p)) continue;
      const x = Math.round(p.sx);
      const y = Math.round(p.sy);
      const focus = hovered.has(m.id) || selected.has(m.id);

      if (!m.upcoming) {
        const c = focus ? palette.focus : palette.meetupPast;
        put(x, y, c);
        put(x - 1, y, c);
        put(x + 1, y, c);
        put(x, y - 1, c);
        put(x, y + 1, c);
        if (focus) drawBrackets(x, y, 4);
        continue;
      }

      const age = (time * 0.45 + m.phase / TAU) % 1;
      const radius = 1 + age * 9;
      const n = Math.ceil(radius * TAU);
      for (let i = 0; i < n; i += age > 0.6 ? 2 : 1) {
        const a = (i / n) * TAU;
        put(x + Math.cos(a) * radius, y + Math.sin(a) * radius * Math.max(0.35, p.z), palette.meetupRing);
      }

      const bob = Math.sin(time * 2.4 + m.phase) > 0 ? 1 : 0;
      const color = focus ? palette.focus : palette.meetup;
      const hy = y - 6 - bob;
      put(x, y, palette.meetupCore);
      for (let k = 1; k <= 3 + bob; k++) put(x, y - k, color);
      for (let dy = -2; dy <= 2; dy++) {
        const w = 2 - Math.abs(dy);
        for (let dx = -w; dx <= w; dx++) put(x + dx, hy + dy, Math.abs(dx) === w || Math.abs(dy) === 2 ? color : palette.meetupCore);
      }
      if (focus) drawBrackets(x, hy, 5);
    }
  }

  function renderSelf() {
    if (!self) return;
    const p = project(self.lat, self.lon);
    if (p.z < 0.08 || !onScreen(p)) return;
    const x = Math.round(p.sx);
    const y = Math.round(p.sy);
    const r = Math.sin(time * 3) > 0 ? 3 : 4;
    for (const [ox, oy, c] of [[1, 1, palette.selfShadow], [0, 0, palette.self]]) {
      for (let i = -r; i <= r; i++) {
        if (Math.abs(i) < r - 1) continue;
        for (const [dx, dy] of [[i, -r], [i, r], [-r, i], [r, i]]) put(x + dx + ox, y + dy + oy, c);
      }
      put(x + ox, y + oy, c);
    }
    const lx = x + r + 3;
    drawMicro("you", lx, y - 2, (px, py) => put(px + 1, py + 1, palette.selfShadow));
    drawMicro("you", lx, y - 2, (px, py) => put(px, py, palette.self));
  }

  function drawBrackets(x, y, r) {
    for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      put(x + sx * r, y + sy * r, palette.focus);
      put(x + sx * (r - 1), y + sy * r, palette.focus);
      put(x + sx * r, y + sy * (r - 1), palette.focus);
    }
  }

  // Labels shown last frame are placed first and keep their side, so they
  // don't flicker or swap sides as the globe turns.
  function renderLabels() {
    if (zoom < LABEL_ZOOM) {
      shownLabels = new Map();
      return;
    }
    const taken = [[logoX - 2, logoY - 2, logoX + logoText.width * logoScale + 2, logoY + logoText.height * logoScale + 2]];
    const budget = Math.round(10 + (zoom - LABEL_ZOOM) * 9);
    const counts = new Map(active.map((a) => [a.city.id, a.count]));
    const cityParts = (city, color) => {
      const parts = [{ text: cityLabels.get(city.id), color }];
      if (counts.has(city.id)) parts.push({ text: String(counts.get(city.id)), color: palette.labelCount });
      return parts;
    };

    const candidates = [];
    const labelled = new Set();
    for (const m of markers) {
      if (!m.upcoming) continue;
      if (m.cityId) {
        if (labelled.has(m.cityId)) continue;
        labelled.add(m.cityId);
        const city = CITY_BY_ID.get(m.cityId);
        candidates.push({ key: city.id, at: city, parts: cityParts(city, palette.meetup) });
      } else if (m.label) {
        candidates.push({ key: m.id, at: m, parts: [{ text: m.label, color: palette.meetup }] });
      }
    }
    for (const a of active) {
      if (labelled.has(a.city.id)) continue;
      labelled.add(a.city.id);
      candidates.push({ key: a.city.id, at: a.city, parts: cityParts(a.city, palette.label) });
    }
    if (zoom >= ALL_CITIES_ZOOM) {
      for (const c of citiesByWeight) {
        if (labelled.has(c.id)) continue;
        candidates.push({ key: c.id, at: c, parts: [{ text: cityLabels.get(c.id), color: palette.labelDim }], dot: palette.cityDot });
      }
    }
    candidates.sort((a, b) => shownLabels.has(b.key) - shownLabels.has(a.key));

    const shown = new Map();
    for (const { key, at, parts, dot } of candidates) {
      if (shown.size >= budget) break;
      const p = project(at.lat, at.lon);
      if (p.z < 0.25 || !onScreen(p)) continue;
      const width = parts.reduce((w, part) => w + microWidth(part.text) + (w ? 4 : 0), 0);
      const x = Math.round(p.sx);
      const y = Math.round(p.sy);
      const sides = shownLabels.get(key) === "left" ? ["left", "right"] : ["right", "left"];
      for (const side of sides) {
        const lx = side === "right" ? x + 4 : x - 4 - width;
        const rect = [lx - 1, y - 3, lx + width + 1, y + MICRO_H - 1];
        if (rect[0] < 1 || rect[2] >= W - 1 || rect[1] < 1 || rect[3] >= H - 1) continue;
        if (taken.some((t) => rect[0] <= t[2] && rect[2] >= t[0] && rect[1] <= t[3] && rect[3] >= t[1])) continue;
        taken.push(rect);
        shown.set(key, side);
        if (dot) put(x, y, dot);
        let cx0 = lx;
        for (const part of parts) {
          drawMicro(part.text, cx0, y - 2, (px, py) => put(px + 1, py + 1, palette.labelShadow));
          drawMicro(part.text, cx0, y - 2, (px, py) => put(px, py, part.color));
          cx0 += microWidth(part.text) + 4;
        }
        break;
      }
    }
    shownLabels = shown;
  }

  function render() {
    buf.set(background);
    renderStars();
    renderGlobe();
    renderRings();
    renderBeacons();
    renderMarkers();
    renderLabels();
    renderSelf();
    renderParticles();
    renderLogo();
    return pixels;
  }

  function tick(dt) {
    update(Math.min(0.1, Math.max(0, dt)));
    return render();
  }

  function setTheme(theme) {
    palette = buildPalette(resolveTheme(theme));
    if (W) buildBackground();
  }

  return {
    resize,
    tick,
    setHeat,
    setTheme,
    setSelf,
    pulse,
    setMarkers,
    setHighlight,
    pick,
    rotateBy,
    setDragging,
    nudge,
    zoomAt,
    flyTo,
    setView,
    project,
    unproject,
    setAutoRotate: (on) => (autoRotate = on),
    get pixels() {
      return pixels;
    },
    get width() {
      return W;
    },
    get height() {
      return H;
    },
    get rotation() {
      return { lat: pitch / DEG, lon: yaw / DEG };
    },
    get zoom() {
      return zoom;
    },
  };
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

export { CITIES };
