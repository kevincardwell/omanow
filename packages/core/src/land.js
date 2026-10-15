import { LAND_B64, LAND_H, LAND_W } from "./land-data.js";

// Hand-rolled base64 decode: the core must run where atob/Buffer don't exist
// (e.g. a Quickshell/QML JS engine).
function decodeBase64(s) {
  const map = new Uint8Array(128);
  const abc = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  for (let i = 0; i < abc.length; i++) map[abc.charCodeAt(i)] = i;
  const clean = s.replace(/=+$/, "");
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let o = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const a = map[clean.charCodeAt(i)];
    const b = map[clean.charCodeAt(i + 1)];
    const c = map[clean.charCodeAt(i + 2)];
    const d = map[clean.charCodeAt(i + 3)];
    out[o++] = (a << 2) | (b >> 4);
    if (o < out.length) out[o++] = ((b & 15) << 4) | (c >> 2);
    if (o < out.length) out[o++] = ((c & 3) << 6) | d;
  }
  return out;
}

const bits = decodeBase64(LAND_B64);

// Unpacked to one byte per cell so the per-pixel globe loop is a single lookup.
export const LAND = new Uint8Array(LAND_W * LAND_H);
for (let i = 0; i < LAND.length; i++) LAND[i] = (bits[i >> 3] >> (i & 7)) & 1;
export { LAND_W, LAND_H };

export function isLand(latDeg, lonDeg) {
  const col = ((Math.floor(((lonDeg + 180) / 360) * LAND_W) % LAND_W) + LAND_W) % LAND_W;
  const row = Math.min(LAND_H - 1, Math.max(0, Math.floor(((90 - latDeg) / 180) * LAND_H)));
  return LAND[row * LAND_W + col] === 1;
}
