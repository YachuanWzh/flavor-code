import { constants } from "node:fs";
import { access, lstat, readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { rgPath as bundledRgPath } from "@vscode/ripgrep";

import { loadConfig, type LoadedConfig } from "./config/load.js";
import type { FlavorConfig } from "./config/schema.js";
import { PluginManifestSchema } from "./plugins/types.js";
import { resolveRuntimeShell } from "./tools/shell.js";
import { fetchLatestVersion } from "./update/check.js";
import { execFileNoThrow } from "./utils/execFileNoThrow.js";
import { gte } from "./utils/semver.js";
import { packageVersion } from "./utils/version.js";

export type DoctorStatus = "pass" | "warn" | "fail";

export interface DoctorCheck {
  name: string;
  status: DoctorStatus;
  message: string;
}

export interface DoctorReport {
  version: string;
  platform: NodeJS.Platform | string;
  arch: string;
  workspace: string;
  checks: DoctorCheck[];
  summary: { passed: number; warnings: number; failed: number };
  ok: boolean;
}

export interface DoctorOptions {
  workspace?: string;
  home?: string;
  environment?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform | string;
  arch?: string;
  nodeVersion?: string;
  registryTimeoutMs?: number;
}

export interface DoctorDependencies {
  loadConfig?: typeof loadConfig;
  fetchLatestVersion?: typeof fetchLatestVersion;
  rgPath?: string;
  probeShell?: (platform: NodeJS.Platform | string, environment: NodeJS.ProcessEnv) => Promise<string | undefined>;
}

export async function runDoctor(
  options: DoctorOptions = {},
  dependencies: DoctorDependencies = {},
): Promise<DoctorReport> {
  const workspace = resolve(options.workspace ?? process.cwd());
  const home = resolve(options.home ?? homedir());
  const environment = options.environment ?? process.env;
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const nodeVersion = options.nodeVersion ?? process.version;
  const checks: DoctorCheck[] = [];

  checks.push(runtimeCheck(nodeVersion, platform, arch));
  checks.push(await directoryCheck("workspace", workspace, false));
  checks.push(await directoryCheck("state directory", join(home, ".flavor-code"), true, home));

  let loaded: LoadedConfig | undefined;
  try {
    loaded = await (dependencies.loadConfig ?? loadConfig)({
      cwd: workspace,
      home,
      environment,
      seedGlobalEnv: false,
    });
    checks.push({
      name: "configuration",
      status: "pass",
      message: loaded.sources.length === 0
        ? "defaults are valid; no config files found"
        : `valid (${loaded.sources.length} source${loaded.sources.length === 1 ? "" : "s"})`,
    });
  } catch (error) {
    checks.push({ name: "configuration", status: "fail", message: errorMessage(error) });
  }

  checks.push(providerCheck(loaded?.config, environment));
  checks.push(await searchCheck(dependencies.rgPath ?? bundledRgPath));

  try {
    const shell = await (dependencies.probeShell ?? probeShell)(platform, environment);
    checks.push(shell === undefined
      ? { name: "shell", status: "fail", message: "no usable command shell found" }
      : { name: "shell", status: "pass", message: shell });
  } catch (error) {
    checks.push({ name: "shell", status: "fail", message: errorMessage(error) });
  }

  checks.push(await pluginCheck([
    join(home, ".flavor-code", "plugins"),
    join(workspace, ".flavor", "plugins"),
  ]));

  try {
    const latest = await (dependencies.fetchLatestVersion ?? fetchLatestVersion)({
      timeoutMs: options.registryTimeoutMs ?? 3_000,
    });
    checks.push(latest === undefined
      ? { name: "npm registry", status: "warn", message: "unreachable or returned an invalid response" }
      : { name: "npm registry", status: "pass", message: `reachable; latest flavor-code is v${latest}` });
  } catch (error) {
    checks.push({ name: "npm registry", status: "warn", message: errorMessage(error) });
  }

  const summary = {
    passed: checks.filter(({ status }) => status === "pass").length,
    warnings: checks.filter(({ status }) => status === "warn").length,
    failed: checks.filter(({ status }) => status === "fail").length,
  };
  return {
    version: packageVersion(), platform, arch, workspace, checks, summary,
    ok: summary.failed === 0,
  };
}

export function formatDoctorReport(report: DoctorReport): string {
  const labels: Record<DoctorStatus, string> = { pass: "ok", warn: "warn", fail: "fail" };
  const lines = [
    `Flavor Doctor v${report.version}`,
    `Platform: ${report.platform} ${report.arch}`,
    `Workspace: ${report.workspace}`,
    "",
    ...report.checks.map((check) => `[${labels[check.status]}] ${check.name}: ${check.message}`),
    "",
    `Summary: ${report.summary.passed} passed, ${report.summary.warnings} warning${report.summary.warnings === 1 ? "" : "s"}, ${report.summary.failed} failed`,
  ];
  return `${lines.join("\n")}\n`;
}

function runtimeCheck(version: string, platform: NodeJS.Platform | string, arch: string): DoctorCheck {
  const major = Number.parseInt(version.replace(/^v/u, "").split(".")[0] ?? "", 10);
  if (!Number.isInteger(major) || !gte(`${major}.0.0`, "20.0.0")) {
    return { name: "runtime", status: "fail", message: `Node ${version} is unsupported; Node 20+ is required` };
  }
  return { name: "runtime", status: "pass", message: `Node ${version} (${platform} ${arch})` };
}

async function directoryCheck(name: string, path: string, mayBeCreated: boolean, parent = path): Promise<DoctorCheck> {
  try {
    const info = await stat(path);
    if (!info.isDirectory()) return { name, status: "fail", message: `${path} is not a directory` };
    await access(path, constants.R_OK | constants.W_OK);
    return { name, status: "pass", message: `${path} is readable and writable` };
  } catch (error) {
    if (mayBeCreated && errorCode(error) === "ENOENT") {
      try {
        await access(parent, constants.R_OK | constants.W_OK);
        return { name, status: "pass", message: `${path} can be created` };
      } catch (parentError) {
        return { name, status: "fail", message: errorMessage(parentError) };
      }
    }
    return { name, status: "fail", message: errorMessage(error) };
  }
}

function providerCheck(config: FlavorConfig | undefined, environment: NodeJS.ProcessEnv): DoctorCheck {
  if (config === undefined) return { name: "providers", status: "warn", message: "skipped because configuration is invalid" };
  const configured = Object.keys(config.providers);
  const environmentProviders = [
    environment.OPENAI_API_KEY ? "openai env" : undefined,
    environment.ANTHROPIC_API_KEY ? "anthropic env" : undefined,
  ].filter((value): value is string => value !== undefined);
  if (configured.length === 0 && environmentProviders.length === 0) {
    return { name: "providers", status: "warn", message: "no provider or API credential detected" };
  }
  const parts = [
    configured.length > 0 ? `${configured.length} configured` : undefined,
    environmentProviders.length > 0 ? environmentProviders.join(", ") : undefined,
  ].filter((value): value is string => value !== undefined);
  return { name: "providers", status: "pass", message: parts.join("; ") };
}

async function searchCheck(path: string): Promise<DoctorCheck> {
  try {
    await access(path, constants.R_OK);
    return { name: "search", status: "pass", message: `bundled ripgrep found at ${path}` };
  } catch (error) {
    return { name: "search", status: "fail", message: `bundled ripgrep is unavailable: ${errorMessage(error)}` };
  }
}

async function probeShell(platform: NodeJS.Platform | string, environment: NodeJS.ProcessEnv): Promise<string | undefined> {
  const shell = resolveRuntimeShell(platform, environment);
  if (shell === undefined) return undefined;
  const sentinel = "flavor-shell-ok";
  const args = shell.kind === "posix"
    ? ["-c", `printf '${sentinel}'`]
    : shell.kind === "cmd"
      ? ["/d", "/s", "/c", `echo|set /p=${sentinel}`]
      : ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", `[Console]::Out.Write('${sentinel}')`];
  const result = await execFileNoThrow(shell.command, args, { timeout: 2_000, useCwd: false, env: environment });
  if (result.code !== 0 || result.stdout !== sentinel) {
    const detail = result.stderr.trim() || result.error || `unexpected output ${JSON.stringify(result.stdout)}`;
    throw new Error(`${shell.command} was found but failed its execution probe: ${detail}`);
  }
  return `${shell.command} (${shell.kind}; execution probe passed)`;
}

async function pluginCheck(directories: readonly string[]): Promise<DoctorCheck> {
  let valid = 0;
  const diagnostics: string[] = [];
  for (const directory of directories) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (errorCode(error) !== "ENOENT") diagnostics.push(`${directory}: ${errorMessage(error)}`);
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const root = resolve(directory, entry.name);
      try {
        const rootInfo = await lstat(root);
        if (rootInfo.isSymbolicLink()) throw new Error("plugin directory must not be a symbolic link");
        const manifest = PluginManifestSchema.parse(JSON.parse(await readFile(join(root, "flavor-plugin.json"), "utf8")));
        const main = resolve(root, manifest.main);
        const delta = relative(root, main);
        if (delta === ".." || delta.startsWith(`..${sep}`) || isAbsolute(delta)) throw new Error("plugin entry escapes its root");
        const mainInfo = await lstat(main);
        if (!mainInfo.isFile() || mainInfo.isSymbolicLink()) throw new Error("plugin entry must be a regular file");
        valid += 1;
      } catch (error) {
        diagnostics.push(`${entry.name}: ${errorMessage(error)}`);
      }
    }
  }
  if (diagnostics.length > 0) {
    return { name: "plugins", status: "warn", message: `${valid} valid; ${diagnostics.join("; ")}` };
  }
  return { name: "plugins", status: "pass", message: valid === 0 ? "no project or global plugins found" : `${valid} manifest${valid === 1 ? "" : "s"} valid` };
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error ? String((error as NodeJS.ErrnoException).code) : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
