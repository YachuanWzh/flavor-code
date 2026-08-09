import { defineConfig } from "tsup";

const sourceMap = process.env.FLAVOR_SOURCEMAP === "1";

export default defineConfig({
  entry: ["extensions/vscode/src/extension.ts"],
  format: ["cjs"],
  platform: "node",
  target: "node20",
  external: ["vscode"],
  outDir: "extensions/vscode/dist",
  clean: true,
  dts: false,
  sourcemap: sourceMap,
  outExtension: () => ({ js: ".js" }),
});
