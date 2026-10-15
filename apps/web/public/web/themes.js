// Theme picker for the web host: the stock Omarchy themes, plus "your Omarchy
// theme" when the plugin opened the page with #theme=<hex>. The fragment
// never reaches the server; the choice is remembered in this browser only.

import { decodeTheme, resolveTheme } from "../core/theme.js";
import { THEMES } from "../core/themes.js";

const KEY = "omaglobe.theme";
const CUSTOM = "custom";
const CSS_VARS = {
  "--bg": "darker_background",
  "--fg": "foreground",
  "--fg-dim": "dark_foreground",
  "--fg-bright": "bright_foreground",
  "--accent": "accent",
  "--hot": "yellow",
  "--live": "green",
  "--panel": "dark_background",
  "--line": "selection",
  "--error": "red",
};

const pretty = (name) => name.replace(/(^|-)(\w)/g, (_, dash, c) => (dash ? " " : "") + c.toUpperCase());

function luminance(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function createThemePicker({ select, scene, storage }) {
  function apply(theme) {
    const t = resolveTheme(theme);
    scene.setTheme(t);
    const root = document.documentElement.style;
    for (const [v, key] of Object.entries(CSS_VARS)) root.setProperty(v, t[key]);
    root.colorScheme = luminance(t.background) > 0.5 ? "light" : "dark";
  }

  function render(selected, custom) {
    const options = Object.keys(THEMES).map((name) => new Option(pretty(name), name));
    if (custom) options.unshift(new Option("your Omarchy theme", CUSTOM));
    select.replaceChildren(...options);
    select.value = selected;
  }

  function choose(value, custom) {
    const theme = value === CUSTOM ? custom : THEMES[value];
    if (!theme) return choose("tokyo-night", custom);
    apply(theme);
    render(value, custom);
    storage(KEY, value === CUSTOM ? `${CUSTOM}:${select.dataset.custom}` : value);
  }

  const fromLink = new URLSearchParams(location.hash.slice(1)).get("theme");
  const saved = storage(KEY) || "";
  const customHex = decodeTheme(fromLink) ? fromLink : saved.startsWith(`${CUSTOM}:`) ? saved.slice(CUSTOM.length + 1) : "";
  const custom = decodeTheme(customHex);
  if (custom) select.dataset.custom = customHex;
  if (fromLink) history.replaceState(null, "", location.pathname + location.search);

  choose(decodeTheme(fromLink) ? CUSTOM : saved.startsWith(`${CUSTOM}:`) ? CUSTOM : saved || "tokyo-night", custom);
  select.addEventListener("change", () => choose(select.value, custom));
}
