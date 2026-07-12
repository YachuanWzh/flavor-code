import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const cwd = resolve(import.meta.dirname, "..");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const prefix = await mkdtemp(join(tmpdir(), "flavor-install-"));
let tarball;

try {
  const packed = await exec(npm, ["pack", "--json", "--silent"], { cwd, windowsHide: true, maxBuffer: 10 * 1024 * 1024 });
  const report = JSON.parse(packed.stdout);
  if (!Array.isArray(report) || typeof report[0]?.filename !== "string") throw new Error("npm pack did not report a tarball");
  tarball = resolve(cwd, report[0].filename);
  await exec(npm, ["install", "--global", "--prefix", prefix, tarball], { cwd, windowsHide: true, maxBuffer: 10 * 1024 * 1024 });
  const binary = process.platform === "win32" ? join(prefix, "flavor.cmd") : join(prefix, "bin", "flavor");
  const version = await exec(binary, ["--version"], { cwd: prefix, windowsHide: true });
  if (version.stdout.trim() !== "0.1.0") throw new Error(`Unexpected installed version: ${version.stdout.trim()}`);
  const help = await exec(binary, ["--help"], {
    cwd: prefix, windowsHide: true,
    env: { ...process.env, OPENAI_API_KEY: "", ANTHROPIC_API_KEY: "", NO_PROXY: "*" },
  });
  if (!help.stdout.includes("--print") || !help.stdout.includes("--resume")) throw new Error("Installed CLI help is incomplete");
  process.stdout.write(`smoke-install: ${binary} -> ${version.stdout.trim()} (help offline)\n`);
} finally {
  await rm(prefix, { recursive: true, force: true });
  if (tarball !== undefined) await rm(tarball, { force: true });
}
