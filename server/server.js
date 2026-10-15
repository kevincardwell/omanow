// Omaglobe server: static files, opt-in API and a live event stream.
// Zero dependencies. Stores only a hashed client token -> city id.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { homedir } from "node:os";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CITIES, CITY_BY_ID } from "../src/core/cities.js";
import { parseColorsToml } from "../src/core/theme.js";
import { createMeetupsSource, MEETUPS_PAGE } from "./meetups.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STATIC_ROOT = join(ROOT, "src");
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json",
};
const CLIENT_ID = /^[A-Za-z0-9-]{16,64}$/;

const hashId = (id) => createHash("sha256").update(id).digest("hex");

function loadStore(file) {
  try {
    const data = JSON.parse(readFileSync(file, "utf8"));
    return new Map(Object.entries(data).filter(([, city]) => CITY_BY_ID.has(city)));
  } catch {
    return new Map();
  }
}

function saveStore(file, store) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(Object.fromEntries(store)));
  renameSync(tmp, file);
}

function omarchyTheme() {
  const candidates = [
    process.env.OMAGLOBE_THEME_FILE,
    join(homedir(), ".local/state/omarchy/current/theme/colors.toml"),
    join(homedir(), ".config/omarchy/current/theme/colors.toml"),
  ].filter(Boolean);
  for (const file of candidates) {
    if (existsSync(file)) return parseColorsToml(readFileSync(file, "utf8"));
  }
  return {};
}

function readJson(req, limit = 1024) {
  return new Promise((ok, fail) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > limit) {
        fail(new Error("too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        ok(JSON.parse(body || "{}"));
      } catch (e) {
        fail(e);
      }
    });
    req.on("error", fail);
  });
}

export function createOmaglobeServer({
  dataFile = join(ROOT, "data/optins.json"),
  demo = false,
  theme = omarchyTheme,
  meetups = createMeetupsSource(),
} = {}) {
  const store = loadStore(dataFile); // hashed client id -> city id
  const fake = new Map(); // demo-only counts, never persisted
  const clients = new Set();
  let heatTimer = null;
  let demoTimer = null;

  function snapshot() {
    const counts = new Map(fake);
    for (const city of store.values()) counts.set(city, (counts.get(city) || 0) + 1);
    let total = 0;
    for (const n of counts.values()) total += n;
    return { total, cities: [...counts].filter(([, n]) => n > 0) };
  }

  function send(res, event, data) {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  function broadcast(event, data) {
    for (const res of clients) send(res, event, data);
  }

  // Coalesce bursts of changes into one heat update.
  function scheduleHeat() {
    if (heatTimer) return;
    heatTimer = setTimeout(() => {
      heatTimer = null;
      broadcast("heat", snapshot());
    }, 250);
  }

  function json(res, status, data) {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(data));
  }

  async function handleApi(req, res, path) {
    if (req.method === "GET" && path === "/api/heat") return json(res, 200, snapshot());
    if (req.method === "GET" && path === "/api/theme") return json(res, 200, theme());
    if (req.method === "GET" && path === "/api/meetups") {
      try {
        const { at, meetups: list } = await meetups();
        return json(res, 200, { updated: new Date(at).toISOString(), source: MEETUPS_PAGE, meetups: list });
      } catch {
        return json(res, 502, { error: "meetups unavailable", meetups: [] });
      }
    }

    if (req.method === "GET" && path === "/api/events") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
      res.write("retry: 3000\n\n");
      send(res, "heat", snapshot());
      clients.add(res);
      const ping = setInterval(() => res.write(": ping\n\n"), 25000);
      req.on("close", () => {
        clearInterval(ping);
        clients.delete(res);
      });
      return;
    }

    if (req.method === "POST" && (path === "/api/share" || path === "/api/unshare")) {
      let body;
      try {
        body = await readJson(req);
      } catch {
        return json(res, 400, { error: "invalid body" });
      }
      if (typeof body.id !== "string" || !CLIENT_ID.test(body.id)) return json(res, 400, { error: "invalid id" });
      const key = hashId(body.id);

      if (path === "/api/unshare") {
        if (store.delete(key)) {
          saveStore(dataFile, store);
          scheduleHeat();
        }
        return json(res, 200, { sharing: null });
      }

      if (!CITY_BY_ID.has(body.city)) return json(res, 400, { error: "unknown city" });
      if (store.get(key) !== body.city) {
        store.set(key, body.city);
        saveStore(dataFile, store);
        broadcast("join", { city: body.city });
        scheduleHeat();
      }
      return json(res, 200, { sharing: body.city });
    }

    json(res, 404, { error: "not found" });
  }

  function handleStatic(req, res, path) {
    if (req.method !== "GET" && req.method !== "HEAD") return json(res, 405, { error: "method not allowed" });
    const rel = path === "/" ? "web/index.html" : normalize(decodeURIComponent(path)).replace(/^[/\\]+/, "");
    const file = resolve(STATIC_ROOT, rel);
    if (!file.startsWith(STATIC_ROOT + "/") || !existsSync(file)) {
      res.writeHead(404, { "content-type": "text/plain" });
      return res.end("not found");
    }
    try {
      const body = readFileSync(file);
      res.writeHead(200, { "content-type": MIME[extname(file)] || "application/octet-stream", "cache-control": "no-cache" });
      res.end(req.method === "HEAD" ? undefined : body);
    } catch {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
    }
  }

  const server = createHttpServer((req, res) => {
    const path = new URL(req.url, "http://x").pathname;
    if (path.startsWith("/api/")) {
      handleApi(req, res, path).catch(() => json(res, 500, { error: "internal" }));
    } else {
      handleStatic(req, res, path);
    }
  });

  if (demo) {
    // Synthetic crowd so the globe is alive locally: seeded counts plus a
    // steady trickle of joins (and the odd leave) broadcast like real ones.
    const weighted = CITIES.flatMap((c) => Array(c.weight * c.weight).fill(c.id));
    for (const c of CITIES) {
      if (Math.random() < 0.8) fake.set(c.id, Math.max(1, Math.round(c.weight ** 2.1 * (0.4 + Math.random()))));
    }
    const step = () => {
      const city = weighted[Math.floor(Math.random() * weighted.length)];
      if (Math.random() < 0.15 && (fake.get(city) || 0) > 1) {
        fake.set(city, fake.get(city) - 1);
      } else {
        fake.set(city, (fake.get(city) || 0) + 1);
        broadcast("join", { city });
      }
      scheduleHeat();
      demoTimer = setTimeout(step, 300 + Math.random() * 1200);
    };
    demoTimer = setTimeout(step, 1000);
  }

  server.on("close", () => {
    clearTimeout(demoTimer);
    clearTimeout(heatTimer);
    for (const res of clients) res.end();
  });

  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const demo = process.argv.includes("--demo");
  const port = Number(process.env.PORT) || 4242;
  const host = process.env.HOST || "127.0.0.1";
  createOmaglobeServer({ demo }).listen(port, host, () => {
    console.log(`omaglobe${demo ? " (demo crowd)" : ""} → http://${host === "0.0.0.0" ? "localhost" : host}:${port}`);
  });
}
