import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

let cached: string | undefined;

/**
 * Resolve the package version from the nearest package.json, walking up from
 * this module. This stays correct in the source tree, in the bundled
 * `dist/` output, and in an installed npm package.
 */
export function packageVersion(): string {
  if (cached !== undefined) return cached;
  let directory = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    try {
      const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8")) as { version?: string };
      if (typeof manifest.version === "string" && manifest.version.length > 0) {
        cached = manifest.version;
        return cached;
      }
    } catch {
      // Keep walking up to the next directory.
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  throw new Error("package.json with a version field was not found");
}
