import { defineConfig } from "tsup";

const sourceMap = process.env.FLAVOR_SOURCEMAP === "1";

export default defineConfig({
  entry: {
    cli: "src/launcher.ts",
    "cli-main": "src/cli.tsx",
    "sdk/index": "src/sdk/index.ts",
    "plugin-worker-entry": "src/plugins/plugin-worker-entry.ts",
  },
  format: ["esm"],
  dts: false,
  clean: true,
  sourcemap: sourceMap,
  // React 19's development reconciler emits one User Timing measure for
  // every component commit. Node retains those measures until explicitly
  // cleared, which made a long-lived Ink TUI retain gigabytes. Claude Code's
  // Ink build relies on this production constant being folded at bundle time.
  define: {
    "process.env.NODE_ENV": JSON.stringify("production"),
  },
  banner: {
    // Claude Code's Ink fork includes CommonJS React internals such as
    // react-reconciler and react/compiler-runtime. The application bundle is
    // ESM, so expose Node's require bridge to every generated chunk.
    js: "#!/usr/bin/env node\nimport { createRequire } from \"node:module\"; const require = createRequire(import.meta.url);",
  },
});
