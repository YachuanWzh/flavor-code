import { defineConfig } from "tsup";

const sourceMap = process.env.FLAVOR_SOURCEMAP === "1";

export default defineConfig([
  {
    entry: { main: "src/desktop/main.ts", "pixel-worker": "src/d2c/pixel-worker.ts" },
    outDir: "dist/desktop",
    format: ["esm"],
    platform: "node",
    target: "node20",
    splitting: false,
    sourcemap: sourceMap,
    clean: false,
    external: ["electron"],
  },
  {
    entry: { preload: "src/desktop/preload.ts" },
    outDir: "dist/desktop",
    format: ["cjs"],
    platform: "node",
    target: "node20",
    splitting: false,
    sourcemap: sourceMap,
    clean: false,
    external: ["electron"],
    outExtension: () => ({ js: ".cjs" }),
  },
]);
