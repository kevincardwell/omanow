# Contributing

You need Node 22.13+ and pnpm.

```sh
pnpm install
pnpm demo            # a fake crowd → http://localhost:8787
pnpm dev:solo        # real data; one machine is enough to show up
pnpm test
```

`pnpm dev` runs with the production rules. A city needs three machines, and
the map updates once a minute. `pnpm reset` deletes local data.

## Where things are

```
packages/core   the globe itself: scene, cities, land, themes
apps/web        the site (public/) and the Cloudflare Worker (worker/)
apps/plugin     the omarchy bar widget
```

Core runs in the browser and inside omarchy's shell, whose JavaScript engine
is older than a browser's. Keep it free of DOM, timers and `atob`, and skip
object spread, numeric separators and `catch {}` without a binding.

## Trying the plugin

```sh
pnpm dev:solo
omarchy bar set io.github.mark-omarov.omanow server http://localhost:8787
pnpm plugin:install
```

Run `pnpm plugin:install` again after a change. The shell caches modules, so
after touching `model.mjs` or core, run `omarchy restart shell` too.

## Sending a change

If it changes what people see or get, run `pnpm changeset` and commit the
file it makes. Docs and refactors don't need one.
