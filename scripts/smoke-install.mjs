import { execFile } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const cwd = resolve(import.meta.dirname, "..");
const npmCli = process.env.npm_execpath
  ?? (process.platform === "win32" ? join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js") : undefined);
const npm = npmCli === undefined ? "npm" : process.execPath;
const npmArgs = npmCli === undefined ? [] : [npmCli];
const prefix = await mkdtemp(join(tmpdir(), "flavor-install-"));
let tarball;

try {
  const packed = await exec(npm, [...npmArgs, "pack", "--json", "--silent"], { cwd, windowsHide: true, maxBuffer: 10 * 1024 * 1024 });
  const reportJson = packed.stdout.match(/(\[\s*\{[\s\S]*\}\s*\])\s*$/)?.[1];
  if (reportJson === undefined) throw new Error("npm pack did not emit a JSON report");
  const report = JSON.parse(reportJson);
  if (!Array.isArray(report) || typeof report[0]?.filename !== "string") throw new Error("npm pack did not report a tarball");
  tarball = resolve(cwd, report[0].filename);
  await exec(npm, [...npmArgs, "install", "--global", "--prefix", prefix, tarball], { cwd, windowsHide: true, maxBuffer: 10 * 1024 * 1024 });
  const binary = process.platform === "win32" ? join(prefix, "flavor.cmd") : join(prefix, "bin", "flavor");
  const installedCli = process.platform === "win32"
    ? join(prefix, "node_modules", "flavor-code", "dist", "cli.js")
    : join(prefix, "lib", "node_modules", "flavor-code", "dist", "cli.js");
  await access(binary);
  const binaryOptions = { cwd: prefix, windowsHide: true };
  const version = await exec(process.execPath, [installedCli, "--version"], binaryOptions);
  if (version.stdout.trim() !== "0.5.0") throw new Error(`Unexpected installed version: ${version.stdout.trim()}`);
  const help = await exec(process.execPath, [installedCli, "--help"], {
    ...binaryOptions,
    env: { ...process.env, OPENAI_API_KEY: "", ANTHROPIC_API_KEY: "", NO_PROXY: "*" },
  });
  if (!help.stdout.includes("--print") || !help.stdout.includes("--resume")) throw new Error("Installed CLI help is incomplete");
  process.stdout.write(`smoke-install: ${binary} -> ${version.stdout.trim()} (help offline)\n`);
} finally {
  await rm(prefix, { recursive: true, force: true });
  if (tarball !== undefined) await rm(tarball, { force: true });
}
