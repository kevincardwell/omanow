# omaglobe

A pixel-art globe of omarchy machines online. The omarchy plugin puts a
globe in your bar; switch it on and your **city** (never coordinates) counts
on the map while the machine is online. Visiting the site shares nothing. Cities glow as a heatmap, particles stream from the hot spots into the
`OMAGLOBE` wordmark, and Omarchy meetups from
[omarchy.org/meetups](https://omarchy.org/meetups) show as green pins.

It runs on the Cloudflare Workers free plan: static files from Workers Static
Assets, the API in a Worker, and opt-ins in one Durable Object with SQLite.

```sh
pnpm install
pnpm demo            # synthetic crowd, updates every 3 s → http://localhost:8787
pnpm dev             # real data only, stored under apps/web/.wrangler/state
pnpm dev:solo        # same, but one machine shows and changes publish in 5 s
pnpm reset           # wipe that local data
pnpm test
pnpm plugin:install  # build the bar widget and load it into your Omarchy shell
```

Node ≥ 22.13 and pnpm (the `packageManager` field pins the version).

## Layout

```
packages/core   host-agnostic engine: scene, city catalogue, land mask, themes
apps/web        the site (public/) and the Cloudflare Worker (worker/)
apps/plugin     the Omarchy bar widget (QML), built into dist/
```

`packages/core` has no DOM, timers or `atob`, so the browser and the QML
plugin share it. The web build copies it to `public/core/`; the plugin build
copies `cities.js` and `theme.js` as `.mjs`, which is how QML imports ES
modules. Code in core must stay within what QML's JavaScript engine parses:
no object spread, no numeric separators, no `catch {}` without a binding.

## The Omarchy plugin

```sh
omarchy plugin add https://github.com/mark-omarov/omaglobe-plugin --enable
omarchy bar move io.github.mark-omarov.omaglobe --after omarchy.indicators
```

Keys, IPC commands and an omarchy menu entry are in `apps/plugin/src/README.md`.

`omarchy plugin add` clones a whole repo and needs `manifest.json` at its
root, and `omarchy plugin update` fast-forwards to the default branch. So the
plugin ships from its own repo,
[omaglobe-plugin](https://github.com/mark-omarov/omaglobe-plugin), which
receives `apps/plugin/dist` only on a release. Users get released versions
and a review diff with only plugin code in it.

To try a change locally:

```sh
pnpm demo                                              # in one terminal
omarchy bar set io.github.mark-omarov.omaglobe server http://localhost:8787
pnpm plugin:install                                    # after each change
```

The shell hot-reloads the widget, but it caches ES modules for the life of
the process: after changing `model.mjs` or core, run `omarchy restart shell`.

## Privacy

The goal is that no one can be identified from what omaglobe stores or shows.

- Only the plugin shares, and it's off until switched on. The site stores
  nothing about visitors.
- Only a city id from `packages/core/src/cities.js` is accepted. The weather
  widget's location and the timezone are snapped to a city on the machine
  and never sent.
- The plugin sends a random install id and the city once an hour while on.
  The server keeps the id's hash, the city and the minute of the last
  heartbeat, and drops it 65 minutes later or when switched off.
- No IPs, accounts, cookies or analytics. Rate limiting counts per IP in
  memory, for the current minute only. Workers Logs are off.
- A city appears publicly only once **3** machines are there (`MIN_PER_CITY`).
- The map is published at most once a minute with every change in that window
  merged, so a change can't be pinned to the moment someone joined.
- The page loads nothing from third parties except meetup covers from
  omarchy.org (`no-referrer`). Fonts are self-hosted. A theme passed by the
  plugin travels in the URL fragment, which browsers never send.

Someone who watches a person join and then sees a small city gain one in the
next quiet minute can still guess. Raising `MIN_PER_CITY` or the publish
interval makes that harder.

## Releases

[Changesets](https://github.com/changesets/changesets) versions
`@omaglobe/web` and `@omaglobe/plugin`. Add one with `pnpm changeset` in any
PR that changes behavior. On `main`, the release workflow keeps a
"chore: release" PR open with the pending bumps; merging it tags each bumped
package, creates GitHub releases, deploys the site if `@omaglobe/web` moved,
and pushes the plugin repo if `@omaglobe/plugin` moved. A core change bumps
both.

Repository secrets the workflow needs:

| Secret | What |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | API token with the "Edit Cloudflare Workers" template |
| `CLOUDFLARE_ACCOUNT_ID` | the account the Worker lives in |
| `PLUGIN_DEPLOY_KEY` | private half of a deploy key with write access on `omaglobe-plugin` |

Also allow GitHub Actions to create pull requests (Settings → Actions →
General), then set the repository variable `RELEASES_ENABLED` to `true`.
Until then the release job is skipped and only tests run.

## Free plan budget

100k Worker requests/day (static files don't count), and per Durable Object
100k requests, 5M SQLite rows read and 100k rows written per day. A plugin
heartbeat is one request and one row an hour, so about 4,000 always-on
machines fit. Heartbeats that change nothing are never rate limited; new
machines and city moves get 12 a minute per IP. Over a limit, requests fail until 00:00
UTC.

## License

MIT, see `LICENSE`. JetBrains Mono is under the SIL Open Font License
(`apps/web/public/fonts/OFL.txt`). Stock theme colors come from
[omacom/omarchy](https://github.com/omacom/omarchy) (MIT).
