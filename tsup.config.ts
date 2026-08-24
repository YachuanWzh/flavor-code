import { defineConfig } from "tsup";

const sourceMap = process.env.FLAVOR_SOURCEMAP === "1";

export default defineConfig({
  entry: {
    cli: "src/cli.tsx",
    "sdk/index": "src/sdk/index.ts",
    "plugin-worker-entry": "src/plugins/plugin-worker-entry.ts",
  },
  format: ["esm"],
  dts: false,
  clean: true,
  sourcemap: sourceMap,
  banner: {
    // Claude Code's Ink fork includes CommonJS React internals such as
    // react-reconciler and react/compiler-runtime. The application bundle is
    // ESM, so expose Node's require bridge to every generated chunk.
    js: "#!/usr/bin/env node\nimport { createRequire } from \"node:module\"; const require = createRequire(import.meta.url);",
  },
});
