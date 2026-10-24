import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { assert, log } from "./load.mjs";
const root = process.argv[2];
const hash = createHash("sha256");
function walk(relative) {
  for (const item of fs.readdirSync(path.join(root, relative), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, "en"))) {
    const next = `${relative}/${item.name}`;
    if (item.isDirectory()) walk(next);
    else if (item.isFile() && (next.endsWith(".ts") || next.endsWith(".js"))) { hash.update(next); hash.update(fs.readFileSync(path.join(root, next))); }
  }
}
walk("src");
walk("dist");
log("Effect.version", "4.0.2");
log("Node.version", process.version);
log("Effect.sourceAndRuntimeSha256", hash.digest("hex"));
assert(fs.existsSync(path.join(root, "src", "reactivity", "Atom.ts")));
