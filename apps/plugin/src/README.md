# omaglobe for omarchy

A globe in your bar that puts your machine on the
[omaglobe](https://omaglobe.mark-omarov.workers.dev) map while it's online.

<p align="center"><img src="https://raw.githubusercontent.com/mark-omarov/omaglobe/main/docs/media/plugin.png" alt="The omaglobe popup: a share switch, the city, and an open-the-map button" width="342"></p>

```sh
omarchy plugin add https://github.com/mark-omarov/omaglobe-plugin --enable
omarchy bar move io.github.mark-omarov.omaglobe --after omarchy.indicators
```

It stays hidden like the indicators until you hover the middle of the bar.
Once you're sharing it stays put.

## Using it

Click the globe, pick your city, flip the switch. Locate (the crosshair)
fills in the nearest city from your weather setting, or your timezone if the
weather has no place saved. Right-click the globe to open the map in your
current theme; it follows when you switch themes.

From the keyboard, with the popup open: `enter` shares, `l` locates, `o`
opens the map, `?` explains, `esc` closes. Without it:

```sh
omarchy-shell omaglobe toggleSharing
omarchy-shell omaglobe toggle
```

Want it in the omarchy menu, next to Stay Awake? Add this to
`~/.config/omarchy/extensions/omarchy-menu.jsonc`:

```jsonc
"trigger.toggle.omaglobe": {"icon":"󰇧","label":"omaglobe","action":"omarchy-shell -q omaglobe toggleSharing","checked":"jq -e .online ~/.local/state/omaglobe/state.json >/dev/null 2>&1"},
```

## What it sends

The city you picked and a random install id, once an hour, while it's on.
Nothing else. The server keeps a hash of the id and forgets it about an hour
after the last check-in, or the moment you switch off. If your connection
drops, it keeps your setting and tries again a little later each time.

Your settings live in `~/.local/state/omaglobe/state.json`, out of your
dotfiles.

## Uninstall

```sh
omarchy plugin remove io.github.mark-omarov.omaglobe
rm -r ~/.local/state/omaglobe
```

Source, issues and the rest of omaglobe:
[mark-omarov/omaglobe](https://github.com/mark-omarov/omaglobe). This repo is
built from there on each release. MIT.
