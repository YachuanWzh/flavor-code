import { access, readFile } from "node:fs/promises";
import { win32 } from "node:path";

export interface AgentLaunch {
  command: string;
  args: string[];
}

interface LaunchResolutionOptions {
  platform?: NodeJS.Platform;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  fileExists?(path: string): Promise<boolean>;
  readText?(path: string): Promise<string>;
}

/**
 * Resolve the configured CLI without asking a shell to concatenate arguments.
 * On Windows, npm exposes package binaries as .cmd shims, which Node cannot
 * execute directly with shell:false. For Flavor's npm shim we launch its JS
 * entry point with node.exe instead.
 */
export async function resolveAgentLaunch(
  executable: string,
  args: readonly string[],
  options: LaunchResolutionOptions = {},
): Promise<AgentLaunch> {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") return { command: executable, args: [...args] };

  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const fileExists = options.fileExists ?? defaultFileExists;
  const readText = options.readText ?? ((path: string) => readFile(path, "utf8"));
  const resolved = await resolveWindowsExecutable(executable, cwd, env, fileExists);
  if (resolved === undefined) {
    throw new Error(
      `Flavor CLI "${executable}" was not found. Install flavor-code globally or set flavorCode.executable to its absolute path.`,
    );
  }

  const extension = win32.extname(resolved).toLowerCase();
  if (extension === ".js" || extension === ".mjs" || extension === ".cjs") {
    const node = await resolveNodeExecutable(resolved, env, fileExists);
    return { command: node, args: [resolved, ...args] };
  }
  if (extension !== ".cmd" && extension !== ".bat") {
    return { command: resolved, args: [...args] };
  }

  const entry = await resolveFlavorNpmEntry(resolved, fileExists, readText);
  if (entry === undefined) {
    throw new Error(
      `Flavor CLI shim "${resolved}" could not be resolved safely. Set flavorCode.executable to flavor-code/dist/cli.js.`,
    );
  }
  const node = await resolveNodeExecutable(resolved, env, fileExists);
  return { command: node, args: [entry, ...args] };
}

async function resolveWindowsExecutable(
  executable: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  fileExists: (path: string) => Promise<boolean>,
): Promise<string | undefined> {
  if (win32.isAbsolute(executable) || executable.includes("/") || executable.includes("\\")) {
    const path = win32.isAbsolute(executable) ? executable : win32.resolve(cwd, executable);
    if (await fileExists(path)) return path;
    if (win32.extname(path).length === 0) {
      for (const extension of windowsExecutableExtensions(env)) {
        if (await fileExists(`${path}${extension}`)) return `${path}${extension}`;
      }
    }
    return undefined;
  }

  for (const directory of pathDirectories(env)) {
    const base = win32.join(directory, executable);
    if (win32.extname(executable).length > 0) {
      if (await fileExists(base)) return base;
      continue;
    }
    for (const extension of windowsExecutableExtensions(env)) {
      if (await fileExists(`${base}${extension}`)) return `${base}${extension}`;
    }
  }
  return undefined;
}

async function resolveFlavorNpmEntry(
  shim: string,
  fileExists: (path: string) => Promise<boolean>,
  readText: (path: string) => Promise<string>,
): Promise<string | undefined> {
  const conventional = win32.join(win32.dirname(shim), "node_modules", "flavor-code", "dist", "cli.js");
  if (await fileExists(conventional)) return conventional;

  try {
    const source = await readText(shim);
    const match = source.match(/%dp0%[\\/]([^"\r\n]*flavor-code[\\/]dist[\\/]cli\.js)/i);
    if (match?.[1] !== undefined) {
      const parsed = win32.resolve(win32.dirname(shim), match[1]);
      if (await fileExists(parsed)) return parsed;
    }
  } catch {
    // The actionable resolution error is produced by the caller.
  }
  return undefined;
}

async function resolveNodeExecutable(
  near: string,
  env: NodeJS.ProcessEnv,
  fileExists: (path: string) => Promise<boolean>,
): Promise<string> {
  const adjacent = win32.join(win32.dirname(near), "node.exe");
  if (await fileExists(adjacent)) return adjacent;
  for (const directory of pathDirectories(env)) {
    const candidate = win32.join(directory, "node.exe");
    if (await fileExists(candidate)) return candidate;
  }
  throw new Error("node.exe was not found on PATH; Flavor Code requires Node.js 20 or newer.");
}

function pathDirectories(env: NodeJS.ProcessEnv): string[] {
  const value = environmentValue(env, "PATH") ?? "";
  return value.split(";")
    .map((item) => item.trim().replace(/^"|"$/g, ""))
    .filter((item) => item.length > 0);
}

function windowsExecutableExtensions(env: NodeJS.ProcessEnv): string[] {
  return (environmentValue(env, "PATHEXT") ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((extension) => extension.startsWith(".") ? extension : `.${extension}`)
    .map((extension) => extension.toLowerCase());
}

function environmentValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const key = Object.keys(env).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key === undefined ? undefined : env[key];
}

async function defaultFileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
