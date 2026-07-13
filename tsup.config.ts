import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/cli.tsx"],
  format: ["esm"],
  clean: true,
  sourcemap: true,
  banner: {
    // Claude Code's Ink fork includes CommonJS React internals such as
    // react-reconciler and react/compiler-runtime. The application bundle is
    // ESM, so expose Node's require bridge to every generated chunk.
    js: "#!/usr/bin/env node\nimport { createRequire } from \"node:module\"; const require = createRequire(import.meta.url);",
  },
});
