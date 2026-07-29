import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["extensions/vscode/src/extension.ts"],
  format: ["cjs"],
  platform: "node",
  target: "node20",
  external: ["vscode"],
  outDir: "extensions/vscode/dist",
  clean: true,
  dts: false,
  sourcemap: true,
  outExtension: () => ({ js: ".js" }),
});
