// Runs after `next build`. Writes out/sw.js with the list of every built file, so the
// service worker can store the whole app on the device and run it with no connection.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

const outDir = path.resolve(import.meta.dirname, "../out");
const files = [];
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full);
    else files.push("/" + path.relative(outDir, full).split(path.sep).join("/"));
  }
};
walk(outDir);
const assets = files.filter((f) => f !== "/sw.js").sort();
const hash = createHash("sha256");
for (const f of assets) hash.update(f).update(readFileSync(path.join(outDir, f)));
const version = hash.digest("hex").slice(0, 12);

const template = readFileSync(path.resolve(import.meta.dirname, "sw.template.js"), "utf8");
writeFileSync(path.join(outDir, "sw.js"), template.replace("__VERSION__", version).replace("__ASSETS__", JSON.stringify(assets)));
console.log(`Service worker written: version ${version}, ${assets.length} files precached`);
