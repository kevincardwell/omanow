// Copies dist/ into the Omarchy shell's plugin directory for local testing.
// The shell hot-reloads it; rerun after each change.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dist = join(dirname(fileURLToPath(import.meta.url)), "../dist");
const { id } = JSON.parse(readFileSync(join(dist, "manifest.json"), "utf8"));
const target = join(homedir(), ".config/omarchy/plugins", id);

if (existsSync(join(target, ".git"))) {
  console.error(`${target} is a git install; remove it with \`omarchy plugin remove ${id}\` first.`);
  process.exit(1);
}
rmSync(target, { recursive: true, force: true });
cpSync(dist, target, { recursive: true });
execFileSync("omarchy-plugin-validate", [target], { stdio: "inherit" });
execFileSync("omarchy-shell", ["shell", "rescanPlugins"], { stdio: "inherit" });
console.log(`Installed ${id}. Enable it with: omarchy plugin enable ${id}`);
