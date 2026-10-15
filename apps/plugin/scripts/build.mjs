// Assembles dist/: the exact tree published to the plugin repo and cloned by
// `omarchy plugin add`. QML imports ES modules only as .mjs, so the shared
// core files are copied under that extension.
import { cpSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(here, "dist");
const core = (file) => fileURLToPath(import.meta.resolve(`@omaglobe/core/${file}`));

rmSync(dist, { recursive: true, force: true });
cpSync(join(here, "src"), dist, { recursive: true });
cpSync(core("cities.js"), join(dist, "cities.mjs"));
cpSync(core("theme.js"), join(dist, "theme.mjs"));
cpSync(join(here, "../../LICENSE"), join(dist, "LICENSE"));

const { version } = JSON.parse(readFileSync(join(here, "package.json"), "utf8"));
const manifest = JSON.parse(readFileSync(join(dist, "manifest.json"), "utf8"));
writeFileSync(join(dist, "manifest.json"), `${JSON.stringify({ ...manifest, version }, null, 2)}\n`);
