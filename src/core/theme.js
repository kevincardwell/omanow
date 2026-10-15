// Palette keys mirror Omarchy's theme colors.toml so a plugin can pass the
// active theme straight through. Defaults are Omarchy's Tokyo Night.
export const DEFAULT_THEME = {
  background: "#1a1b26",
  dark_background: "#13141c",
  darker_background: "#0e0e14",
  lighter_background: "#24283b",
  foreground: "#a9b1d6",
  dark_foreground: "#565f89",
  bright_foreground: "#c0caf5",
  accent: "#7aa2f7",
  muted: "#414868",
  red: "#f7768e",
  yellow: "#e0af68",
  orange: "#eb927b",
  green: "#9ece6a",
  cyan: "#449dab",
  blue: "#7aa2f7",
  magenta: "#ad8ee6",
  bright_yellow: "#ff9e64",
  bright_cyan: "#0db9d7",
  bright_magenta: "#bb9af7",
};

// Minimal parser for Omarchy's flat `key = "#rrggbb"` colors.toml.
export function parseColorsToml(text) {
  const theme = {};
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*([a-z_]+)\s*=\s*"(#[0-9a-fA-F]{6})"/);
    if (m) theme[m[1]] = m[2].toLowerCase();
  }
  return theme;
}

export function resolveTheme(partial) {
  return { ...DEFAULT_THEME, ...(partial || {}) };
}
