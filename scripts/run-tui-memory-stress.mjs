import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

import { build } from "esbuild";

const output = resolve(".flavor/tmp/stress-tui-memory.mjs");
await mkdir(resolve(".flavor/tmp"), { recursive: true });
await build({
  absWorkingDir: process.cwd(),
  entryPoints: ["scripts/stress-tui-memory.tsx"],
  outfile: output,
  bundle: true,
  packages: "external",
  platform: "node",
  format: "esm",
  target: "node20",
  sourcemap: false,
  logLevel: "warning",
});

const child = spawn(process.execPath, [
  "--max-old-space-size=96",
  "--max-semi-space-size=4",
  "--expose-gc",
  output,
], {
  stdio: "inherit",
  env: { ...process.env, NODE_ENV: "development" },
});
const code = await new Promise((resolvePromise, reject) => {
  child.once("error", reject);
  child.once("exit", (exitCode) => resolvePromise(exitCode ?? 1));
});
process.exitCode = code;
