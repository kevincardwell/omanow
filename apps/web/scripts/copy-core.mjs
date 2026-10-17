// The browser imports the engine from /core/, next to the page.
import { cpSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const web = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(dirname(fileURLToPath(import.meta.resolve("@omanow/core/scene.js"))));
const out = join(web, "public/core");
rmSync(out, { recursive: true, force: true });
cpSync(src, out, { recursive: true });
