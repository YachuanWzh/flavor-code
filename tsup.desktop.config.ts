import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: { main: "src/desktop/main.ts" },
    outDir: "dist/desktop",
    format: ["esm"],
    platform: "node",
    target: "node20",
    splitting: false,
    sourcemap: true,
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
    sourcemap: true,
    clean: false,
    external: ["electron"],
    outExtension: () => ({ js: ".cjs" }),
  },
]);

