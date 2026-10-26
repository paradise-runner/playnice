// Records a build stamp so a running daemon can tell it is serving stale code.
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const version = require("../package.json").version;
const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "");

mkdirSync(join(root, "dist"), { recursive: true });
writeFileSync(
  join(root, "dist", "build.json"),
  `${JSON.stringify({ version, stamp, builtAt: new Date().toISOString() }, null, 2)}\n`,
);
process.stdout.write(`playnice build ${version}+${stamp}\n`);
