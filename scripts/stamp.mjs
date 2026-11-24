// Records a content-based build stamp so a running daemon can tell it is
// serving stale code. Content, not time: rebuilding unchanged source must not
// restart the daemon and kill live sessions (including a running publish).
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const version = require("../package.json").version;
const dist = join(root, "dist");

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(path));
    else if (!path.endsWith("build.json")) out.push(path);
  }
  return out.sort();
}

const hash = createHash("sha256");
hash.update(version);
for (const file of walk(dist)) {
  hash.update(file.slice(dist.length));
  hash.update(readFileSync(file));
}
const stamp = hash.digest("hex").slice(0, 12);

mkdirSync(dist, { recursive: true });
writeFileSync(
  join(dist, "build.json"),
  `${JSON.stringify({ version, stamp, builtAt: new Date().toISOString() }, null, 2)}\n`,
);
process.stdout.write(`playnice build ${version}+${stamp}\n`);
