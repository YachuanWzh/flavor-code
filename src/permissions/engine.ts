import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, parse, relative, resolve, sep } from "node:path";

import type { FlavorConfig } from "../config/schema.js";

export type PermissionMode = FlavorConfig["permissionMode"];
export type PermissionDecision = { decision: "allow" | "deny" | "ask"; reason?: string };

export interface PermissionRequest {
  agent: "main" | "subagent";
  tool: string;
  paths?: readonly string[];
  command?: string;
  cwd?: string;
}

export interface PermissionEngineOptions {
  workspace: string;
  mode?: PermissionMode;
}

const READ_TOOLS = new Set(["Read", "Glob", "Grep", "Search", "List"]);
const WRITE_TOOLS = new Set(["Write", "Edit", "ApplyPatch", "Delete", "Move", "Copy", "Mkdir"]);
const SHELL_TOOLS = new Set(["Shell", "Bash", "Command", "Exec"]);
const NETWORK_TOOLS = new Set(["WebFetch", "WebSearch", "Fetch", "Network"]);
const PATH_REQUIRED_TOOLS = new Set(["Read", "Write", "Edit", "ApplyPatch", "Glob", "Grep"]);

export class PermissionEngine {
  readonly #workspace: string;
  readonly #mode: PermissionMode;

  constructor(options: PermissionEngineOptions) {
    const root = resolve(options.workspace);
    this.#workspace = existsSync(root) ? realpathSync.native(root) : root;
    this.#mode = options.mode ?? "workspace";
  }

  decide(request: PermissionRequest): PermissionDecision {
    const paths = request.paths ?? [];
    if (PATH_REQUIRED_TOOLS.has(request.tool) && paths.length === 0) {
      return { decision: "deny", reason: `${request.tool} requires at least one path` };
    }
    for (const path of paths) {
      const classification = classifyPath(this.#workspace, path);
      if (classification.escape) return { decision: "deny", reason: classification.reason ?? "Path escapes the workspace" };
      if (request.agent === "subagent" && !classification.inside) {
        return { decision: "deny", reason: "Subagents are restricted to the workspace" };
      }
    }

    const inside = paths.every((path) => classifyPath(this.#workspace, path).inside);
    if (READ_TOOLS.has(request.tool)) {
      if (this.#mode === "safe" || this.#mode === "full" || inside) return { decision: "allow" };
      return { decision: "ask", reason: "Read is outside the workspace" };
    }
    if (WRITE_TOOLS.has(request.tool)) {
      if (this.#mode === "safe") return { decision: "ask", reason: "Safe mode requires approval for writes" };
      if (this.#mode === "full" || inside) return { decision: "allow" };
      return { decision: "ask", reason: "Write is outside the workspace" };
    }
    if (SHELL_TOOLS.has(request.tool)) return this.#shellDecision(request);
    if (NETWORK_TOOLS.has(request.tool)) {
      if (request.agent === "subagent") return { decision: "ask", reason: "Subagent network access requires main-Agent approval" };
      return this.#mode === "full" ? { decision: "allow" } : { decision: "ask", reason: "Network access requires approval" };
    }
    return { decision: "ask", reason: `Unknown tool: ${request.tool}` };
  }

  #shellDecision(request: PermissionRequest): PermissionDecision {
    const analysis = analyzeCommand(request.command ?? "");
    if (request.agent === "subagent") {
      if (request.cwd === undefined) return { decision: "ask", reason: "Subagent shell commands require an explicit workspace cwd" };
      const cwd = classifyPath(this.#workspace, request.cwd);
      if (cwd.escape || !cwd.inside) return { decision: "deny", reason: "Subagent shell cwd must remain in the workspace" };
      if (analysis.destructive) return { decision: "deny", reason: "Destructive commands are forbidden for subagents" };
      if (analysis.wrapped || analysis.opaque || !isRoutineCommand(analysis.command)) return { decision: "ask", reason: "Subagent shell command requires main-Agent approval" };
      return { decision: "allow" };
    }
    if (analysis.destructive) {
      return this.#mode === "full"
        ? { decision: "deny", reason: "Explicitly forbidden high-risk command" }
        : { decision: "ask", reason: "Risky shell command requires approval" };
    }
    if (analysis.opaque) return { decision: "ask", reason: "Opaque shell wrapper requires approval" };
    if (this.#mode === "full") return { decision: "allow" };
    if (this.#mode === "workspace" && isRoutineCommand(analysis.command)) return { decision: "allow" };
    return { decision: "ask", reason: "Shell command requires approval" };
  }
}

interface ClassifiedPath { inside: boolean; escape: boolean; reason?: string }

function classifyPath(workspace: string, input: string): ClassifiedPath {
  const candidate = resolve(workspace, input);
  const lexicalInside = isWithin(workspace, candidate);
  const traversal = input.split(/[\\/]+/).includes("..");
  const startsInWorkspace = pathStartsWith(workspace, input);
  if ((!isAbsolute(input) || startsInWorkspace) && traversal && !lexicalInside) {
    return { inside: false, escape: true, reason: "Path traversal escapes the workspace" };
  }

  const physical = resolvePhysical(candidate);
  const physicalInside = isWithin(workspace, physical);
  if (lexicalInside && !physicalInside) return { inside: false, escape: true, reason: "Symlink escapes the workspace" };
  return { inside: physicalInside, escape: false };
}

function pathStartsWith(root: string, input: string): boolean {
  const normalizeForComparison = (value: string) => process.platform === "win32"
    ? value.replaceAll("/", "\\").toLowerCase()
    : value;
  const normalizedRoot = normalizeForComparison(root);
  const normalizedInput = normalizeForComparison(input);
  return normalizedInput === normalizedRoot || normalizedInput.startsWith(`${normalizedRoot}${sep}`);
}

function resolvePhysical(path: string): string {
  let current = path;
  const tail: string[] = [];
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) return path;
    tail.unshift(current.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)));
    current = parent;
  }
  const base = realpathSync.native(current);
  return resolve(base, ...tail);
}

function isWithin(root: string, candidate: string): boolean {
  const delta = relative(root, candidate);
  return delta === "" || (!delta.startsWith(`..${sep}`) && delta !== ".." && !isAbsolute(delta));
}

interface ParsedCommand { executable: string; args: string[]; raw: string }

interface CommandAnalysis { command: ParsedCommand; destructive: boolean; opaque: boolean; wrapped: boolean }

function analyzeCommand(raw: string, depth = 0): CommandAnalysis {
  const command = parseCommand(raw);
  if (depth > 4) return { command, destructive: false, opaque: true, wrapped: depth > 0 };
  const wrapper = command.executable;
  if (["sh", "bash", "zsh"].includes(wrapper)) {
    const flag = command.args.findIndex((arg) => arg.toLowerCase() === "-c");
    if (flag < 0 || command.args[flag + 1] === undefined) return { command, destructive: false, opaque: true, wrapped: true };
    return { ...analyzeCommand(command.args.slice(flag + 1).join(" "), depth + 1), wrapped: true };
  }
  if (wrapper === "cmd") {
    const flag = command.args.findIndex((arg) => arg.toLowerCase() === "/c");
    if (flag < 0 || command.args[flag + 1] === undefined) return { command, destructive: false, opaque: true, wrapped: true };
    return { ...analyzeCommand(command.args.slice(flag + 1).join(" "), depth + 1), wrapped: true };
  }
  if (["powershell", "pwsh"].includes(wrapper)) {
    const fileFlag = command.args.some((arg) => ["-file", "-f"].includes(arg.toLowerCase()));
    if (fileFlag) return { command, destructive: false, opaque: true, wrapped: true };
    const flag = command.args.findIndex((arg) => ["-command", "-c"].includes(arg.toLowerCase()));
    if (flag < 0 || command.args[flag + 1] === undefined) return { command, destructive: false, opaque: true, wrapped: true };
    return { ...analyzeCommand(command.args.slice(flag + 1).join(" "), depth + 1), wrapped: true };
  }
  return { command, destructive: isForbiddenCommand(command), opaque: false, wrapped: depth > 0 };
}

function parseCommand(raw: string): ParsedCommand {
  const tokens = raw.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map((token) => token.replace(/^(?:"(.*)"|'(.*)')$/, "$1$2")) ?? [];
  const executable = (tokens.shift() ?? "").replace(/\.exe$/i, "").toLowerCase();
  return { executable: parse(executable).name.toLowerCase(), args: tokens, raw: raw.toLowerCase() };
}

function isForbiddenCommand(command: ParsedCommand): boolean {
  if (["shutdown", "reboot", "halt", "mkfs", "diskpart", "format"].includes(command.executable)) return true;
  if (command.executable === "rm" && isDestructiveRm(command.args)) return true;
  for (const match of command.raw.matchAll(/\brm(?:\.exe)?\s+([^;&|]+)/gi)) {
    const nested = parseCommand(`rm ${match[1] ?? ""}`);
    if (isDestructiveRm(nested.args)) return true;
  }
  if (command.executable === "remove-item" && command.args.some((arg) => /^-(recurse|r)$/i.test(arg)) && command.args.some(isFilesystemRoot)) return true;
  if (command.executable === "dd" && command.args.some((arg) => /^of=\/dev\//i.test(arg))) return true;
  return /(^|\s)(git\s+reset\s+--hard|git\s+clean\s+-[^\s]*f)/.test(command.raw);
}

function isDestructiveRm(args: readonly string[]): boolean {
  const shortFlags = args.filter((arg) => /^-[^-]/.test(arg)).join("").toLowerCase();
  const recursive = shortFlags.includes("r") || args.some((arg) => arg.toLowerCase() === "--recursive");
  const force = shortFlags.includes("f") || args.some((arg) => arg.toLowerCase() === "--force");
  return recursive && force && args.some(isFilesystemRoot);
}

function isFilesystemRoot(value: string): boolean {
  return value === "/" || /^[a-z]:[\\/]?$/i.test(value);
}

function isRoutineCommand(command: ParsedCommand): boolean {
  if (/[;&|><`]/.test(command.raw)) return false;
  const first = command.args[0]?.toLowerCase();
  if (["npm", "pnpm", "yarn", "bun"].includes(command.executable)) {
    const task = first === "run" ? command.args[1]?.toLowerCase() : first;
    return ["test", "build", "lint", "typecheck", "check"].includes(task ?? "");
  }
  if (["cargo", "dotnet", "gradle", "gradlew", "mvn"].includes(command.executable)) return ["test", "build", "check", "verify"].includes(first ?? "");
  if (command.executable === "go") return first === "test";
  return ["pytest", "vitest", "jest", "eslint", "tsc", "make"].includes(command.executable);
}
