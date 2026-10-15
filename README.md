# omaglobe

A pixel-art globe of Omarchy users. People can opt in to share their **city**
(never coordinates). Cities glow as a heatmap with light beacons, and particles
stream from the hot spots into the `OMAGLOBE` wordmark, lighting it up.
Omarchy meetups (from the [Luma calendar](https://luma.com/omarchy) that
omarchy.org/meetups lists) show as green pins; click one for its details.

No dependencies are needed to run it (Node ≥ 20).

```sh
npm run demo   # synthetic crowd + live joins every ~second → http://127.0.0.1:4242
npm start      # real data only (starts empty), stored in data/optins.json
npm test
```

## Seeing it work

1. `npm run demo`, then open http://127.0.0.1:4242. About 1.7k fake people
   across ~170 cities. New joins arrive continuously and show as a shockwave
   ring on the globe plus a burst of particles into the logo.
2. Drag to spin (it has inertia), or use the arrow keys. After a moment of no
   input it goes back to spinning on its own.
3. Zoom with the scroll wheel (toward the cursor), pinch, double-click, `+`/`-`,
   or the `[+]`/`[-]` buttons. `0` resets. City labels appear once you zoom in,
   busiest cities first; from about 2.6× they include cities nobody shares
   from yet. Meetup cities are labelled in green.
4. Pins: green = upcoming meetup, dim cross = already happened. Hover a pin to
   see its name, click it for the card (date in the event's timezone, place,
   hosts, cover, link to Luma). **[ meetups · N upcoming ]** lists them all;
   picking one flies the globe there.
5. Open a second window, click **[ share my city ]** and pick a city (or
   "use my location", which snaps to the nearest city inside the browser).
   Both windows show the join, and the counter goes up. **stop** removes it.

Colors come from the active Omarchy theme
(`~/.local/state/omarchy/current/theme/colors.toml`) when it exists, and
default to Tokyo Night otherwise.

## Layout

```
src/core/   host-agnostic engine: no DOM, no timers, no atob
  scene.js    renders everything into an RGBA framebuffer
  cities.js   the city catalogue (the only locations that can be shared)
  land*.js    720×360 land bitmask (generated: npm run build:land)
  font.js     block glyphs for the wordmark
  theme.js    Omarchy colors.toml keys + parser
src/web/    browser host: canvas blit, pointer/keys, SSE, opt-in UI
server/     zero-dep HTTP: static files, /api/share, /api/unshare, /api/heat,
            /api/events (SSE), /api/theme, /api/meetups (Luma, cached 10 min)
```

### Plugin readiness

The future Omarchy shell (Quickshell/QML) plugin can reuse `src/core` as it is:

- `createScene()` → `resize(w, h)`, `tick(dt)` returns RGBA pixels. Also
  `setHeat`, `pulse`, `rotateBy`, `nudge`, `setDragging`, `zoomAt`, `flyTo`,
  `setMarkers`, `pick`, `setHighlight` and `setTheme`. Labels and pins are
  drawn into the framebuffer too, using a built-in 3×5 pixel font.
- The host owns the clock, input and blitting (QML `Canvas` +
  `putImageData`), and gets data from the same `/api/heat` and
  `/api/events` endpoints.
- Theme keys match `colors.toml`, so the active theme can be passed straight in.

## Meetup data

`server/meetups.js` pulls future and past events from Luma's public calendar
endpoint and keeps a few fields: name, time and timezone, city/country,
coordinates, guest count, hosts, cover image and link. If a refresh fails it
keeps serving the last data it got. Online events and events that only share
their address with guests have no coordinates, so, like omarchy.org, they are
placed at their timezone's city. The card then says "online" or "address
shared with guests" and "shown near X". It never presents that guessed city
as the venue.

## Privacy

- Only a city id from `src/core/cities.js` is accepted. Anything else is
  rejected, and extra fields are ignored.
- The browser gets a random token (localStorage), and the server stores only
  its SHA-256 → city id. Public endpoints expose aggregate counts only.
- Geolocation (optional) is converted to the nearest city on the client, and
  the coordinates are never sent.
