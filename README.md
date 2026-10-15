# omaglobe

A pixel-art globe of Omarchy users. People can opt in to share their **city**
(never coordinates). Cities glow as a heatmap with light beacons, and particles
stream from the hot spots into the `OMAGLOBE` wordmark, lighting it up.
Omarchy meetups from [omarchy.org/meetups](https://omarchy.org/meetups) show as
green pins; click one for its details.

It runs on Cloudflare Workers (free plan): static files from Workers Static
Assets, the API in a Worker, and opt-ins in one Durable Object with SQLite.

```sh
npm install
npm run demo   # synthetic crowd, updates every 3 s → http://localhost:8787
npm run dev    # real data only (starts empty), stored under .wrangler/
npm test
```

Node ≥ 22.13 for the tests (they use `node:sqlite`).

## Seeing it work

1. `npm run demo`, then open http://localhost:8787. About 1.9k fake people
   across ~120 visible cities. New joins arrive in batches and show as
   shockwave rings on the globe plus bursts of particles into the logo.
2. Drag to spin (it has inertia), or use the arrow keys. After a moment of no
   input it goes back to spinning on its own.
3. Zoom with the scroll wheel (toward the cursor), pinch, double-click, `+`/`-`,
   or the `[+]`/`[-]` buttons. `0` resets. City labels appear once you zoom in,
   busiest cities first; from about 2.6× they include cities nobody shares
   from yet. Meetup cities are labelled in green.
4. Pins: green = upcoming meetup, dim cross = already happened. Hover a pin to
   see its name, click it for the card (date in the event's timezone, place,
   cover, link to the event). **[ meetups · N upcoming ]** lists them all;
   picking one flies the globe there.
5. Click **[ share my city ]** and pick a city (or "use my location", which
   snaps to the nearest city inside the browser). Your city pulses right away;
   everyone else sees it at the next publish, once 3 people share it.
   **stop** removes it.

## Privacy

The goal is that no one can be identified from what omaglobe stores or shows.

- Only a city id from `src/core/cities.js` is accepted. Anything else is
  rejected, and extra fields are ignored. Geolocation, if used, is snapped to
  the nearest city in the browser and the coordinates are never sent.
- The browser keeps a random token in localStorage. The server stores only
  its SHA-256, the city id and the day it was last seen. No IPs, user agents
  or timestamps finer than a day.
- A city appears publicly only once **3** people share it (`MIN_PEOPLE`).
- The public map changes only when it is published, at most once a minute,
  with every join in that window merged. There is no per-person event, so a
  change on the map can't be pinned to the moment someone shared.
- Opt-ins expire after **180 days** without a visit (`RETENTION_DAYS`). Each
  visit from a sharing browser renews it.
- Rate limiting keeps per-IP counters in memory for the current minute only.
- Workers Logs are off, so omaglobe keeps no request logs. Cloudflare still
  terminates the connection and sees IPs, as any host would.
- The page loads nothing from third parties except meetup covers from
  omarchy.org, sent with `no-referrer`. Fonts are self-hosted.

Someone who watches a person share and then sees a small city gain one in the
next publish can still guess. That needs both the out-of-band observation and
a quiet minute. Raising `MIN_PEOPLE` or the publish interval makes it harder.

## Deploy

On a Cloudflare account (the free plan is enough):

```sh
npx wrangler login
npm run deploy
```

That creates the Worker, the Durable Object and its SQLite storage, and prints
a `*.workers.dev` URL. Add a custom domain under the Worker's settings if you
want one.

Free plan budget: 100k Worker requests/day (static files don't count), and
100k Durable Object requests, 5M SQLite rows read, 100k rows written per day.
A share writes a few rows, and idle viewers on WebSockets cost no duration
because the object hibernates between publishes. Over a limit, requests fail until 00:00 UTC.

## Layout

```
src/            served as static assets
  index.html
  _headers      CSP and other response headers
  core/         host-agnostic engine: no DOM, no timers, no atob
    scene.js      renders everything into an RGBA framebuffer
    cities.js     the city catalogue (the only locations that can be shared)
    land*.js      1440×720 land bitmask (generated: npm run build:land)
    font.js       block glyphs for the wordmark
    theme.js      Omarchy colors.toml keys + parser
  web/          browser host: canvas blit, pointer/keys, WebSocket, opt-in UI
  fonts/        JetBrains Mono (OFL)
worker/
  index.js      routes /api/*, checks writes are same-origin JSON
  globe.js      Durable Object: opt-ins, publishing, live sockets
  meetups.js    omarchy.org meetup listing, cached 10 min
```

API: `GET /api/heat` (the last published map), `GET /api/live` (WebSocket;
sends `{type: "heat", total, cities, min, joins}` on connect and at each
publish, answers `ping` with `pong`), `POST /api/share` `{id, city}`,
`POST /api/unshare` `{id}`, `GET /api/meetups`.

### Plugin readiness

The future Omarchy shell (Quickshell/QML) plugin can reuse `src/core` as it is:

- `createScene()` → `resize(w, h)`, `tick(dt)` returns RGBA pixels. Also
  `setHeat`, `pulse`, `rotateBy`, `nudge`, `setDragging`, `zoomAt`, `flyTo`,
  `setMarkers`, `pick`, `setHighlight` and `setTheme`. Labels and pins are
  drawn into the framebuffer too, using a built-in 3×5 pixel font.
- The host owns the clock, input and blitting (QML `Canvas` +
  `putImageData`), and gets data from `/api/heat` and `/api/live`.
- Theme keys match `colors.toml`, so the local Omarchy theme can be passed
  straight to `setTheme`. The website uses Tokyo Night.

## Meetup data

`worker/meetups.js` reads the listing omarchy.org/meetups is built from
(`src/data/meetups.json` in
[omacom/omarchy-site](https://github.com/omacom/omarchy-site), refreshed daily
from the Omarchy Luma calendar) and keeps the fields the globe needs. If a
refresh fails it keeps serving the last data and waits 10 minutes before
trying again. Events whose address is shared only with guests are placed
approximately by that listing, and the card says so. An event it couldn't
place is shown at its timezone's city, and the card says that too.

## License

MIT. JetBrains Mono is under the SIL Open Font License (`src/fonts/OFL.txt`).
