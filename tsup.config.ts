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
  // Cold-start performance: every external dependency forces Node's ESM
  // loader to stat, read and parse hundreds of small files from
  // node_modules — measured at 17s+ on a cold Windows file cache (Defender
  // scans each file) versus 0.35s warm. Bundling pure-JS dependencies into
  // the dist chunks removes that per-file cost. Packages that resolve
  // native binaries or runtime assets from their own directory must stay
  // external; they are still installed because package.json keeps them as
  // regular dependencies.
  external: [
    // Native addon loaded via createRequire at runtime (src/terminal/service.ts).
    "node-pty",
    // Exposes rgPath pointing at a postinstall-downloaded rg binary.
    "@vscode/ripgrep",
    // WASM runtime assets resolved relative to the package directory.
    "web-tree-sitter",
    "tree-sitter-wasms",
  ],
  noExternal: [/^(?!node:)/u],
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
    // ESM, so expose Node's require bridge to every generated chunk. The
    // import binding is deliberately unique: when a bundled dependency needs
    // its own require bridge, esbuild injects `import { createRequire }`
    // into the same chunk and a shared name would be a duplicate declaration.
    js: "#!/usr/bin/env node\nimport { createRequire as createFlavorRequire } from \"node:module\"; const require = createFlavorRequire(import.meta.url);",
  },
});
