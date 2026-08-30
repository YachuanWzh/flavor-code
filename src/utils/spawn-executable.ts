import { existsSync, statSync } from "node:fs";
import { delimiter, extname, isAbsolute, resolve } from "node:path";

export interface PreparedSpawnInvocation {
  command: string;
  args: string[];
  windowsVerbatimArguments?: boolean;
}

export interface PrepareSpawnOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}

const WINDOWS_EXECUTABLE = /\.(?:com|exe)$/iu;
const WINDOWS_CMD_SHIM = /node_modules[\\/].bin[\\/][^\\/]+\.cmd$/iu;
const CMD_META = /([()\][%!^"`<>&|;, *?])/gu;

/**
 * Resolve a structured command without opting every caller into shell parsing.
 * On Windows only batch files need a cmd.exe bridge; native executables retain
 * the original argv boundary and all other platforms are unchanged.
 */
export function prepareSpawnInvocation(
  command: string,
  args: readonly string[],
  options: PrepareSpawnOptions = {},
): PreparedSpawnInvocation {
  if ((options.platform ?? process.platform) !== "win32") return { command, args: [...args] };

  const env = options.env ?? process.env;
  const commandFile = resolveWindowsCommand(command, options.cwd, env);
  if (commandFile === undefined || WINDOWS_EXECUTABLE.test(commandFile)) {
    return { command: commandFile ?? command, args: [...args] };
  }

  const doubleEscape = WINDOWS_CMD_SHIM.test(commandFile);
  const shellCommand = [escapeCmdCommand(commandFile), ...args.map((arg) => escapeCmdArgument(arg, doubleEscape))].join(" ");
  return {
    command: environmentValue(env, "ComSpec") ?? "cmd.exe",
    args: ["/d", "/s", "/c", `"${shellCommand}"`],
    windowsVerbatimArguments: true,
  };
}

function resolveWindowsCommand(command: string, cwd: string | undefined, env: NodeJS.ProcessEnv): string | undefined {
  const pathValue = environmentValue(env, "PATH") ?? "";
  const pathExt = (environmentValue(env, "PATHEXT") ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .filter(Boolean);
  const hasPath = isAbsolute(command) || /[\\/]/u.test(command);
  const bases = hasPath
    ? [isAbsolute(command) ? command : resolve(cwd ?? process.cwd(), command)]
    : pathValue.split(";").filter(Boolean).map((entry) => resolve(unquote(entry), command));

  for (const base of bases) {
    const candidates = extname(base).length > 0 ? [base] : [base, ...pathExt.map((extension) => `${base}${extension}`)];
    for (const candidate of candidates) {
      if (isRegularFile(candidate)) return resolve(candidate);
    }
  }
  return undefined;
}

function environmentValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const key = Object.keys(env).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key === undefined ? undefined : env[key];
}

function unquote(value: string): string {
  const trimmed = value.trim();
  return trimmed.startsWith('"') && trimmed.endsWith('"') ? trimmed.slice(1, -1) : trimmed;
}

function isRegularFile(path: string): boolean {
  try { return existsSync(path) && statSync(path).isFile(); }
  catch { return false; }
}

function escapeCmdCommand(value: string): string {
  return value.replace(CMD_META, "^$1");
}

function escapeCmdArgument(value: string, doubleEscapeMetaCharacters: boolean): string {
  // Follow cmd.exe's backslash/quote rules; node_modules command shims parse metacharacters twice.
  let escaped = value
    .replace(/(?=(\\+?)?)\1"/gu, "$1$1\\\"")
    .replace(/(?=(\\+?)?)\1$/gu, "$1$1");
  escaped = `"${escaped}"`.replace(CMD_META, "^$1");
  return doubleEscapeMetaCharacters ? escaped.replace(CMD_META, "^$1") : escaped;
}
