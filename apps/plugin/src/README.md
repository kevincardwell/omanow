# omaglobe for omarchy

A globe in your omarchy bar that puts this machine on the
[omaglobe](https://omaglobe.mark-omarov.workers.dev) map, at city level, while
it's online. Off until you switch it on.

```sh
omarchy plugin add https://github.com/mark-omarov/omaglobe-plugin --enable
omarchy bar move io.github.mark-omarov.omaglobe --after omarchy.indicators
```

Like the indicators, it stays out of sight while off and shows when you hover
the middle of the bar. While sharing it stays visible.

## Use

Click the globe and flip the switch. Pick a city, or press locate to use the
nearest one to this machine: the weather widget's saved place if it has one,
otherwise your timezone. Either way it's worked out locally and only the city
is sent. Right-click the globe to open the map in your current omarchy theme;
that page follows your theme switches while it's open.

In the popup: `enter` or `s` share, `l` locate, `o` open the map, `?` help,
`esc` close.

From the keyboard or scripts:

```sh
omarchy-shell omaglobe toggleSharing   # on/off
omarchy-shell omaglobe toggle          # open/close the popup
omarchy-shell omaglobe status
```

To get it in the omarchy menu next to Stay Awake (Trigger > Toggle), add to
`~/.config/omarchy/extensions/omarchy-menu.jsonc`:

```jsonc
"trigger.toggle.omaglobe": {"icon":"󰇧","label":"omaglobe","action":"omarchy-shell -q omaglobe toggleSharing","checked":"jq -e .online ~/.local/state/omaglobe/state.json >/dev/null 2>&1"},
```

## What it sends

While on, once an hour: a random install id and the city you picked. No
coordinates, hostname or username. The server keeps only a hash of the id and
drops it about an hour after the last heartbeat, or right away when you
switch off. A city shows on the map only once 3 people are there. If the
connection drops it keeps your setting and retries after 1, 2, 4 and up to
30 minutes.

A page you open from the globe gets your theme and city in the URL fragment,
which browsers never send. Later theme switches reach that page through the
server, which passes them on and stores nothing.

State lives in `~/.local/state/omaglobe/state.json`. It loads with the shell
and picks up where it left off.

## Settings

`server`: leave empty for the public omaglobe. For a local dev server:

```sh
omarchy bar set io.github.mark-omarov.omaglobe server http://localhost:8787
```

## License

MIT. Provided as is, without warranty. Source and issues:
[mark-omarov/omaglobe](https://github.com/mark-omarov/omaglobe). This
repository is generated from `apps/plugin` there on each release.
