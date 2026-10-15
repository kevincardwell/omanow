// Cloudflare Worker: static files come from the assets binding before this
// runs; everything under /api lands here.

import { json } from "./globe.js";
import { createMeetupsSource, MEETUPS_PAGE } from "./meetups.js";

export { Globe } from "./globe.js";

const meetups = createMeetupsSource();
const GLOBE_PATHS = new Set(["/api/heat", "/api/live", "/api/online", "/api/offline", "/api/sync"]);

// Blocks cross-site form posts and other sites' scripts from writing opt-ins.
function crossSite(request, url) {
  const origin = request.headers.get("origin");
  if (origin && origin !== url.origin) return json(403, { error: "cross-origin request" });
  if (!request.headers.get("content-type")?.startsWith("application/json")) return json(415, { error: "expected application/json" });
  return null;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/meetups" && request.method === "GET") {
      try {
        const { at, meetups: list } = await meetups();
        return json(200, { updated: new Date(at).toISOString(), source: MEETUPS_PAGE, meetups: list }, { "cache-control": "public, max-age=600" });
      } catch {
        return json(502, { error: "meetups unavailable", meetups: [] });
      }
    }

    if (GLOBE_PATHS.has(url.pathname)) {
      const rejected = request.method === "POST" && crossSite(request, url);
      if (rejected) return rejected;
      return env.GLOBE.get(env.GLOBE.idFromName("globe")).fetch(request);
    }

    return json(404, { error: "not found" });
  },
};
