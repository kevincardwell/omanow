# omaglobe for Omarchy

A globe icon in your Omarchy bar that puts this machine on the
[omaglobe](https://omaglobe.mark-omarov.workers.dev) heatmap, at city level,
while it's online. It does nothing until you turn it on.

```sh
omarchy plugin add https://github.com/mark-omarov/omaglobe-plugin --enable
```

Pick the center section when asked. To sit it right after the weather:

```sh
omarchy bar move io.github.mark-omarov.omaglobe --after omarchy.weather
```

## Use

- **Click** the globe: pick your city and press **Show me on the map**.
  Press **Go offline** to stop.
- **Right-click**: open the globe in your browser, in your current Omarchy
  theme.

If the weather widget has a saved location, the nearest city is preselected.

## What it sends

While on, once an hour: a random install id and the city you picked. That's
all. No coordinates, no hostname, no username. The server keeps only a hash
of the id and drops it about an hour after the last heartbeat, or right away
when you go offline. A city shows on the map only once 3 people are there.

The theme link carries your colors in the URL fragment, which browsers never
send to a server.

Local state lives in `~/.local/state/omaglobe/state.json`.

## Settings

`server`: leave empty for the public omaglobe. Point it at a local dev server
with:

```sh
omarchy bar set io.github.mark-omarov.omaglobe server http://localhost:8787
```

## License

MIT. Provided as is, without warranty. Source and issues:
[mark-omarov/omaglobe](https://github.com/mark-omarov/omaglobe). This
repository is generated from `apps/plugin` there on each release.
