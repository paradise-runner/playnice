import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

function readPackageVersion(): string {
  try {
    return (require("../../package.json") as { version?: string }).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/**
 * Version including a per-build stamp.
 *
 * The daemon compares this with its client and replaces itself on mismatch.
 * Without the stamp, a rebuild would leave the old daemon serving old code
 * until someone remembered to restart it.
 */
export const VERSION: string = (() => {
  const base = readPackageVersion();
  try {
    const build = JSON.parse(
      readFileSync(new URL("../../dist/build.json", import.meta.url), "utf8"),
    ) as { stamp?: string };
    return build.stamp ? `${base}+${build.stamp}` : base;
  } catch {
    return base;
  }
})();

/** The version without the build stamp, for display. */
export const BASE_VERSION: string = readPackageVersion();
