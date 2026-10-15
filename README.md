# omaglobe

Who's on omarchy right now, and where.

<p align="center"><img src="docs/media/hero.gif" alt="A pixel-art globe with glowing cities streaming particles into the OMAGLOBE wordmark" width="720"></p>

omaglobe is a pixel globe of omarchy machines that are online right now. Each
one lights up its city. The busier a city, the hotter it glows, and the glow
streams up into the wordmark. Green pins are omarchy meetups, past and coming
up, straight from [omarchy.org/meetups](https://omarchy.org/meetups).

Have a look at **[omaglobe.mark-omarov.workers.dev](https://omaglobe.mark-omarov.workers.dev)**.
Looking costs you nothing: there's no account, no cookie, nothing to share.

## Light up your city

Add the globe to your omarchy bar:

```sh
omarchy plugin add https://github.com/mark-omarov/omaglobe-plugin --enable
omarchy bar move io.github.mark-omarov.omaglobe --after omarchy.indicators
```

Hover the middle of your bar, click the globe, and flip the switch. That's it.
Your machine counts while it's on and drops off about an hour after it isn't.

<p align="center"><img src="docs/media/plugin.png" alt="The omaglobe popup in the omarchy bar: a share switch, the city, and an open-the-map button" width="342"></p>

Right-click the globe and the map opens in your current omarchy theme, and
keeps up when you switch themes. More in the
[plugin README](apps/plugin/src/README.md).

<p align="center"><img src="docs/media/themes.png" alt="The globe in four omarchy themes: nord, gruvbox, catppuccin latte and osaka jade" width="720"></p>

## What it knows about you

Your city. Not your street, not your coordinates, not you.

- It's off until you switch it on. The website never shares anything.
- While on, the plugin sends the city you picked and a random install id,
  once an hour. The server keeps a hash of the id and forgets it about an
  hour after the last check-in, or the moment you switch off.
- A city only appears once three machines are there, and the map moves once a
  minute, so nobody can tell when you joined.
- No names, accounts, IP addresses, cookies or analytics. Locate picks the
  nearest city from your weather setting or timezone, on your machine.

## Make it better

Ideas and bugs go in [issues](https://github.com/mark-omarov/omaglobe/issues).
Code goes in a PR; [CONTRIBUTING.md](CONTRIBUTING.md) gets you running in a
minute.

A community project, not affiliated with omarchy, omacom or 37signals. MIT.
