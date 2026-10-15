// Theme picker for the web host: the stock omarchy themes, plus "your omarchy
// theme" when the plugin opened the page with its colors (or pushes new ones
// after a theme switch). The choice is remembered in this browser only.

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

function luminance(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function createThemePicker({ select, scene, storage, linked }) {
  const saved = storage(KEY) || "";
  let customHex = decodeTheme(linked) ? linked : saved.startsWith(`${CUSTOM}:`) ? saved.slice(CUSTOM.length + 1) : "";

  function apply(theme) {
    const t = resolveTheme(theme);
    scene.setTheme(t);
    const root = document.documentElement.style;
    for (const [v, key] of Object.entries(CSS_VARS)) root.setProperty(v, t[key]);
    root.colorScheme = luminance(t.background) > 0.5 ? "light" : "dark";
  }

  function choose(value) {
    const custom = decodeTheme(customHex);
    const theme = value === CUSTOM ? custom : THEMES[value];
    if (!theme) return choose("tokyo-night");
    apply(theme);
    const options = Object.keys(THEMES).map((name) => new Option(name.replace(/-/g, " "), name));
    if (custom) options.unshift(new Option("your omarchy theme", CUSTOM));
    select.replaceChildren(...options);
    select.value = value;
    storage(KEY, value === CUSTOM ? `${CUSTOM}:${customHex}` : value);
  }

  select.addEventListener("change", () => choose(select.value));
  choose(decodeTheme(linked) || saved.startsWith(`${CUSTOM}:`) ? CUSTOM : saved || "tokyo-night");

  return {
    /** The plugin's colors changed: follow them. */
    follow(hex) {
      if (!decodeTheme(hex)) return;
      customHex = hex;
      choose(CUSTOM);
    },
  };
}
