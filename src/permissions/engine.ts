import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, parse, relative, resolve, sep } from "node:path";

import { normalizePermissionMode, type LegacyPermissionMode, type PermissionMode } from "../config/schema.js";

export type { PermissionMode } from "../config/schema.js";
export type PermissionDecision = {
  decision: "allow" | "deny" | "ask";
  reason?: string;
  /** False when an approval must apply to this call only. */
  allowAlways?: false;
};
export type PermissionProfile = "standard" | "d2c";

export interface PermissionRequest {
  agent: "main" | "subagent";
  tool: string;
  paths?: readonly string[];
  command?: string;
  args?: readonly string[];
  cwd?: string;
  allowAlways?: false;
  /** Declared read-only by the tool definition; granted the same treatment as READ_TOOLS. */
  readOnly?: boolean;
}

export interface PermissionEngineOptions {
  workspace: string;
  mode?: PermissionMode | LegacyPermissionMode;
  profile?: PermissionProfile;
}

const CONTROL_TOOLS = new Set(["TaskPlan", "TaskUpdate", "AskUserQuestion", "TodoWrite", "TaskOutput", "JobList", "JobRead", "JobWait", "JobKill", "TerminalRead", "TerminalList"]);
const COLLABORATION_CONTROL_TOOLS = new Set(["PalsList", "CoWorkState", "CoWorkReady"]);
const COLLABORATION_SHARE_TOOLS = new Set(["PalSend", "CoWorkPlan", "CoWorkProgress", "CoWorkComplete", "CoWorkIntegrate"]);
const READ_TOOLS = new Set(["Read", "Glob", "Grep", "Search", "List", "SkillResource", "LspFindRefs", "LspHover", "LspDiagnostics", "ListRegisteredTools"]);
const WRITE_TOOLS = new Set(["Write", "Edit", "ApplyPatch", "Copy", "Mkdir", "RegisterTool"]);
const DESTRUCTIVE_TOOLS = new Set(["Delete", "Move", "RemoveTool"]);
const SHELL_TOOLS = new Set(["Shell", "Bash", "Command", "Exec", "TerminalOpen", "TerminalWrite", "TerminalResize", "TerminalClose"]);
const NETWORK_TOOLS = new Set(["WebFetch", "WebSearch", "Fetch", "Network"]);
const PATH_REQUIRED_TOOLS = new Set([
  "Read", "Write", "Edit", "ApplyPatch", "Glob", "Grep", "Delete", "Move", "Copy", "Mkdir",
  "RegisterTool", "RemoveTool",
]);

export type ToolCategory = "control" | "read" | "write" | "destructive" | "shell" | "network" | "unknown";

const CATEGORY_MAP: Record<string, ToolCategory> = {};
for (const name of CONTROL_TOOLS) CATEGORY_MAP[name] = "control";
for (const name of READ_TOOLS) CATEGORY_MAP[name] = "read";
for (const name of WRITE_TOOLS) CATEGORY_MAP[name] = "write";
for (const name of DESTRUCTIVE_TOOLS) CATEGORY_MAP[name] = "destructive";
for (const name of SHELL_TOOLS) CATEGORY_MAP[name] = "shell";
for (const name of NETWORK_TOOLS) CATEGORY_MAP[name] = "network";

export function getToolCategory(name: string): ToolCategory {
  return isNetworkTool(name) ? "network" : (CATEGORY_MAP[name] ?? "unknown");
}

export function isDestructiveTool(name: string): boolean {
  return DESTRUCTIVE_TOOLS.has(name);
}

export class PermissionEngine {
  readonly #lexicalWorkspace: string;
  readonly #workspace: string;
  #mode: PermissionMode;
  #profile: PermissionProfile;

  constructor(options: PermissionEngineOptions) {
    const root = resolve(options.workspace);
    // Lexical and physical forms are both needed: traversal detection compares
    // user-supplied lexical paths, while containment checks must compare
    // realpath-resolved paths on both sides (/var -> /private/var on macOS,
    // 8.3 short names in Windows runner temp dirs).
    this.#lexicalWorkspace = root;
    this.#workspace = existsSync(root) ? realpathSync.native(root) : root;
    this.#mode = canonicalMode(options.mode ?? "default");
    this.#profile = options.profile ?? "standard";
  }

  get mode(): PermissionMode { return this.#mode; }
  get profile(): PermissionProfile { return this.#profile; }

  setMode(mode: PermissionMode | LegacyPermissionMode): void { this.#mode = canonicalMode(mode); }
  setProfile(profile: PermissionProfile): void { this.#profile = profile; }

  decide(request: PermissionRequest): PermissionDecision {
    if (request.tool === "Task") return request.agent === "main"
      ? { decision: "allow" }
      : { decision: "deny", reason: "Task delegation is restricted to the main agent" };
    if (CONTROL_TOOLS.has(request.tool)) return { decision: "allow" };
    if (COLLABORATION_CONTROL_TOOLS.has(request.tool)) return request.agent === "main"
      ? { decision: "allow" }
      : { decision: "deny", reason: "Cross-instance collaboration is restricted to the main agent" };
    if (COLLABORATION_SHARE_TOOLS.has(request.tool)) {
      if (request.agent !== "main") return { decision: "deny", reason: "Cross-instance collaboration is restricted to the main agent" };
      return this.#mode === "bypassPermissions"
        ? { decision: "allow" }
        : { decision: "ask", reason: "Sharing content with another local Flavor instance requires approval", allowAlways: false };
    }
    const paths = request.paths ?? [];
    if (PATH_REQUIRED_TOOLS.has(request.tool) && paths.length === 0) {
      return { decision: "deny", reason: `${request.tool} requires at least one path` };
    }
    if ((request.tool === "Move" || request.tool === "Copy") && paths.length < 2) {
      return { decision: "deny", reason: `${request.tool} requires source and destination paths` };
    }
    for (const path of paths) {
      const classification = classifyPath(this.#lexicalWorkspace, this.#workspace, path);
      if (classification.escape) return { decision: "deny", reason: classification.reason ?? "Path escapes the workspace" };
      if (request.agent === "subagent" && !classification.inside) {
        return { decision: "deny", reason: "Subagents are restricted to the workspace" };
      }
    }

    const inside = paths.every((path) => classifyPath(this.#lexicalWorkspace, this.#workspace, path).inside);
    const isRead = READ_TOOLS.has(request.tool) || request.readOnly === true;
    if (this.#profile === "d2c") return this.#d2cDecision(request, inside);
    if (this.#mode === "plan") {
      return isRead
        ? { decision: "allow" }
        : { decision: "deny", reason: "Plan mode is read-only" };
    }
    if (isRead) {
      return { decision: "allow" };
    }
    if (DESTRUCTIVE_TOOLS.has(request.tool)) {
      if (request.agent === "main" && this.#mode === "bypassPermissions") return { decision: "allow" };
      return ask(this.#mode, "Destructive operation requires approval");
    }
    if (WRITE_TOOLS.has(request.tool)) {
      if (request.agent === "main" && this.#mode === "bypassPermissions") return { decision: "allow" };
      if (inside && (this.#mode === "acceptEdits" || this.#mode === "auto")) return { decision: "allow" };
      return ask(this.#mode, inside ? "Write requires approval" : "Write is outside the workspace");
    }
    if (SHELL_TOOLS.has(request.tool)) return this.#shellDecision(request);
    if (isNetworkTool(request.tool)) {
      if (request.agent === "subagent") return ask(this.#mode, "Subagent network access requires main-Agent approval");
      return this.#mode === "bypassPermissions"
        ? { decision: "allow" }
        : ask(this.#mode, "Network access requires approval");
    }
    return ask(this.#mode, `Unknown tool: ${request.tool}`);
  }

  #d2cDecision(request: PermissionRequest, inside: boolean): PermissionDecision {
    if ((request.paths?.length ?? 0) > 0 && !inside) {
      return { decision: "deny", reason: "D2C tools must remain in the workspace" };
    }
    if (READ_TOOLS.has(request.tool) || request.readOnly === true) return { decision: "allow" };
    if (isDeletionTool(request.tool)) {
      return { decision: "ask", reason: "Deletion requires approval", allowAlways: false };
    }
    if (DESTRUCTIVE_TOOLS.has(request.tool)) {
      return request.tool === "Move"
        ? { decision: "allow" }
        : { decision: "ask", reason: "Deletion requires approval", allowAlways: false };
    }
    if (WRITE_TOOLS.has(request.tool)) return { decision: "allow" };
    if (SHELL_TOOLS.has(request.tool)) return this.#d2cShellDecision(request);
    if (isNetworkTool(request.tool)) return { decision: "allow" };
    return { decision: "allow" };
  }

  #d2cShellDecision(request: PermissionRequest): PermissionDecision {
    const analysis = request.args === undefined
      ? analyzeCommand(request.command ?? "")
      : analyzeArgumentCommand(request.command ?? "", request.args);
    const cwd = request.cwd ?? this.#workspace;
    const cwdClassification = classifyPath(this.#lexicalWorkspace, this.#workspace, cwd);
    if (cwdClassification.escape || !cwdClassification.inside) {
      return { decision: "deny", reason: "D2C shell cwd must remain in the workspace" };
    }
    if (analysis.catastrophic) {
      return { decision: "deny", reason: "Explicitly forbidden system-level command" };
    }
    if (isD2cManagedPreviewCommand(analysis.command)) {
      return {
        decision: "deny",
        reason: "D2C preview lifecycle is managed by D2cCompare; pass the project directory directly instead of starting npm/Vite manually",
      };
    }
    if (assessD2cCommandPaths(analysis.command, cwd, this.#workspace, this.#lexicalWorkspace) === "deny") {
      return { decision: "deny", reason: "D2C command arguments escape the workspace" };
    }
    if (analysis.deletion) return { decision: "ask", reason: "Deletion requires approval", allowAlways: false };
    return { decision: "allow" };
  }

  #shellDecision(request: PermissionRequest): PermissionDecision {
    const analysis = request.args === undefined
      ? analyzeCommand(request.command ?? "")
      : analyzeArgumentCommand(request.command ?? "", request.args);
    if (request.agent === "subagent") {
      if (request.cwd === undefined) return { decision: "ask", reason: "Subagent shell commands require an explicit workspace cwd" };
      const cwd = classifyPath(this.#lexicalWorkspace, this.#workspace, request.cwd);
      if (cwd.escape || !cwd.inside) return { decision: "deny", reason: "Subagent shell cwd must remain in the workspace" };
      if (analysis.destructive) return { decision: "deny", reason: "Destructive commands are forbidden for subagents" };
      if (analysis.wrapped || analysis.opaque || !isRoutineCommand(analysis.command)) return { decision: "ask", reason: "Subagent shell command requires main-Agent approval" };
      const argumentDecision = assessRoutineArguments(analysis.command, request.cwd, this.#lexicalWorkspace, this.#workspace);
      if (argumentDecision !== "allow") {
        return argumentDecision === "deny"
          ? { decision: "deny", reason: "Subagent command arguments escape the workspace" }
          : { decision: "ask", reason: "Ambiguous subagent command arguments require main-Agent approval" };
      }
      return { decision: "allow" };
    }
    if (analysis.destructive) {
      return this.#mode === "bypassPermissions" || this.#mode === "auto"
        ? { decision: "deny", reason: "Explicitly forbidden high-risk command" }
        : ask(this.#mode, "Risky shell command requires approval");
    }
    if (analysis.wrapped || analysis.opaque) return ask(this.#mode, "Shell wrapper requires approval");
    if (this.#mode === "bypassPermissions") return { decision: "allow" };
    if ((this.#mode === "acceptEdits" || this.#mode === "auto") && isRoutineCommand(analysis.command)) {
      const cwd = request.cwd ?? this.#lexicalWorkspace;
      const cwdClassification = classifyPath(this.#lexicalWorkspace, this.#workspace, cwd);
      if (cwdClassification.escape || !cwdClassification.inside) {
        return { decision: "deny", reason: "Routine command cwd must remain in the workspace" };
      }
      const argumentDecision = assessRoutineArguments(analysis.command, cwd, this.#lexicalWorkspace, this.#workspace);
      if (argumentDecision === "deny") return { decision: "deny", reason: "Routine command arguments escape the workspace" };
      if (argumentDecision === "ask") return ask(this.#mode, "Ambiguous routine command arguments require approval");
      return { decision: "allow" };
    }
    return ask(this.#mode, "Shell command requires approval");
  }
}

function canonicalMode(mode: PermissionMode | LegacyPermissionMode): PermissionMode {
  return normalizePermissionMode(mode) as PermissionMode;
}

function ask(mode: PermissionMode, reason: string): PermissionDecision {
  return mode === "auto"
    ? { decision: "ask", reason: `Auto classification required: ${reason}` }
    : { decision: "ask", reason };
}

function isNetworkTool(name: string): boolean {
  return NETWORK_TOOLS.has(name) || name.startsWith("mcp__");
}

function isDeletionTool(name: string): boolean {
  if (name === "Delete" || name === "RemoveTool") return true;
  return /(?:^|[_-])(delete|remove|unlink|destroy)(?:[_-]|$)/i.test(name);
}

function analyzeArgumentCommand(executable: string, args: readonly string[]): CommandAnalysis {
  const name = parse(executable.replace(/\.exe$/i, "")).name.toLowerCase();
  const command: ParsedCommand = { executable: name, args: [...args], raw: [executable, ...args].join(" ").toLowerCase() };
  if (["sh", "bash", "zsh"].includes(name)) {
    const flag = args.findIndex((arg) => arg.toLowerCase() === "-c");
    if (flag < 0 || args[flag + 1] === undefined) return commandAnalysis(command, true, true);
    return { ...analyzeCommand(args[flag + 1]!), wrapped: true };
  }
  if (name === "cmd") {
    const flag = args.findIndex((arg) => arg.toLowerCase() === "/c");
    if (flag < 0 || args[flag + 1] === undefined) return commandAnalysis(command, true, true);
    return { ...analyzeCommand(args.slice(flag + 1).join(" ")), wrapped: true };
  }
  if (["powershell", "pwsh"].includes(name)) {
    const flag = args.findIndex((arg) => ["-command", "-c"].includes(arg.toLowerCase()));
    if (flag < 0 || args[flag + 1] === undefined) return commandAnalysis(command, true, true);
    return { ...analyzeCommand(args.slice(flag + 1).join(" ")), wrapped: true };
  }
  return commandAnalysis(command, false, false);
}

interface ClassifiedPath { inside: boolean; escape: boolean; reason?: string }

function classifyPath(lexicalWorkspace: string, physicalWorkspace: string, input: string): ClassifiedPath {
  const candidate = resolve(lexicalWorkspace, input);
  const lexicalInside = isWithin(lexicalWorkspace, candidate);
  const traversal = input.split(/[\\/]+/).includes("..");
  const startsInWorkspace = pathStartsWith(lexicalWorkspace, input);
  if ((!isAbsolute(input) || startsInWorkspace) && traversal && !lexicalInside) {
    return { inside: false, escape: true, reason: "Path traversal escapes the workspace" };
  }

  const physical = resolvePhysical(candidate);
  const physicalInside = isWithin(physicalWorkspace, physical);
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

function isD2cManagedPreviewCommand(command: ParsedCommand): boolean {
  const executable = command.executable.replace(/\.cmd$/i, "");
  const args = command.args.map((arg) => arg.toLowerCase());
  if (executable === "npm") {
    if (args[0] === "start") return true;
    if (args[0] === "run" && ["dev", "start", "serve", "preview"].includes(args[1] ?? "")) return true;
    if (args[0] === "exec" && args.some((arg) => arg === "vite")) return true;
  }
  if (["pnpm", "yarn", "bun"].includes(executable)) {
    const script = args[0] === "run" ? args[1] : args[0];
    if (["dev", "start", "serve", "preview"].includes(script ?? "")) return true;
  }
  if (executable === "npx" && args.some((arg) => arg === "vite")) return true;
  if (executable === "vite") return true;
  if (executable === "node" && args.some((arg) => /(?:^|[\\/])vite[\\/]bin[\\/]vite(?:\.js)?$/i.test(arg))) return true;

  // `cmd /c start /b ...` is unwrapped by the parser, so inspect the retained
  // inner command text as well as structured argv. This is the exact pattern
  // that can leave npm.cmd running as `cmd /K` with inherited stdio handles.
  return /(?:^|[\s;&|])(?:npm(?:\.cmd)?\s+(?:run\s+)?(?:dev|start|serve|preview)|(?:pnpm|yarn|bun)(?:\.cmd)?\s+(?:run\s+)?(?:dev|start|serve|preview)|npx(?:\.cmd)?\s+(?:[^\s]+\s+)*vite|npm(?:\.cmd)?\s+exec\s+(?:--\s+)?vite|vite(?:\.cmd)?|node(?:\.exe)?\s+[^\s]*vite[\\/]bin[\\/]vite(?:\.js)?)(?:\s|$)/i.test(command.raw);
}

interface CommandAnalysis {
  command: ParsedCommand;
  destructive: boolean;
  deletion: boolean;
  catastrophic: boolean;
  opaque: boolean;
  wrapped: boolean;
}

function commandAnalysis(command: ParsedCommand, opaque: boolean, wrapped: boolean): CommandAnalysis {
  return {
    command,
    destructive: isForbiddenCommand(command),
    deletion: isDeletionCommand(command),
    catastrophic: isCatastrophicCommand(command),
    opaque,
    wrapped,
  };
}

function analyzeCommand(raw: string, depth = 0): CommandAnalysis {
  const command = parseCommand(raw);
  if (depth > 4) return commandAnalysis(command, true, depth > 0);
  const wrapper = command.executable;
  if (["sh", "bash", "zsh"].includes(wrapper)) {
    const flag = command.args.findIndex((arg) => arg.toLowerCase() === "-c");
    if (flag < 0 || command.args[flag + 1] === undefined) return commandAnalysis(command, true, true);
    return { ...analyzeCommand(command.args.slice(flag + 1).join(" "), depth + 1), wrapped: true };
  }
  if (wrapper === "cmd") {
    const flag = command.args.findIndex((arg) => arg.toLowerCase() === "/c");
    if (flag < 0 || command.args[flag + 1] === undefined) return commandAnalysis(command, true, true);
    return { ...analyzeCommand(command.args.slice(flag + 1).join(" "), depth + 1), wrapped: true };
  }
  if (["powershell", "pwsh"].includes(wrapper)) {
    const fileFlag = command.args.some((arg) => ["-file", "-f"].includes(arg.toLowerCase()));
    if (fileFlag) return commandAnalysis(command, true, true);
    const flag = command.args.findIndex((arg) => ["-command", "-c"].includes(arg.toLowerCase()));
    if (flag < 0 || command.args[flag + 1] === undefined) return commandAnalysis(command, true, true);
    return { ...analyzeCommand(command.args.slice(flag + 1).join(" "), depth + 1), wrapped: true };
  }
  if (wrapper === "call") {
    if (command.args.length === 0) return commandAnalysis(command, true, true);
    return { ...analyzeCommand(command.args.join(" "), depth + 1), wrapped: true };
  }
  const opaque = ["start", "for", "if"].includes(wrapper) || /[%!()]/.test(command.raw);
  return commandAnalysis(command, opaque, depth > 0);
}

function parseCommand(raw: string): ParsedCommand {
  const tokens = raw.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map((token) => token.replace(/^(?:"(.*)"|'(.*)')$/, "$1$2")) ?? [];
  const executable = (tokens.shift() ?? "").replace(/\.exe$/i, "").toLowerCase();
  return { executable: parse(executable).name.toLowerCase(), args: tokens, raw: raw.toLowerCase() };
}

function isForbiddenCommand(command: ParsedCommand): boolean {
  return isCatastrophicCommand(command)
    || /(^|\s)(git\s+reset\s+--hard|git\s+clean\s+-[^\s]*f)/.test(command.raw);
}

function isCatastrophicCommand(command: ParsedCommand): boolean {
  if (["shutdown", "reboot", "halt", "mkfs", "diskpart", "format"].includes(command.executable)) return true;
  if (/(^|[;&|]\s*)(shutdown|reboot|halt|mkfs|diskpart|format)(?:\.exe)?(?:\s|$)/i.test(command.raw)) return true;
  if (command.executable === "rm" && isDestructiveRm(command.args)) return true;
  for (const match of command.raw.matchAll(/\brm(?:\.exe)?\s+([^;&|]+)/gi)) {
    const nested = parseCommand(`rm ${match[1] ?? ""}`);
    if (isDestructiveRm(nested.args)) return true;
  }
  if (/\b(remove-item|ri)\b/i.test(command.raw)) {
    const recursive = /\s-(recurse|r)(?:\s|$)/i.test(command.raw);
    const root = command.args.some(isFilesystemRoot) || /\s(?:[a-z]:[\\/]?|\/)(?:\s|$)/i.test(command.raw);
    if (recursive && root) return true;
  }
  return command.executable === "dd" && command.args.some((arg) => /^of=\/dev\//i.test(arg));
}

function isDeletionCommand(command: ParsedCommand): boolean {
  if (["rm", "rmdir", "unlink", "del", "erase", "remove-item", "ri"].includes(command.executable)) return true;
  return /(^|[;&|]\s*)(rm|rmdir|unlink|del|erase|remove-item|ri)(?:\.exe)?(?:\s|$)/i.test(command.raw)
    || /(^|\s)git\s+(rm|clean)(?:\s|$)/i.test(command.raw)
    || /(^|\s)git\s+reset\s+--hard(?:\s|$)/i.test(command.raw)
    || /(^|\s)find\s+[^;&|]*(?:-delete|-exec\s+rm)(?:\s|$)/i.test(command.raw);
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
  return ["pytest", "vitest", "jest", "eslint", "tsc"].includes(command.executable);
}

type ArgumentDecision = "allow" | "ask" | "deny";

function assessRoutineArguments(command: ParsedCommand, cwd: string, lexicalWorkspace: string, physicalWorkspace: string): ArgumentDecision {
  const args = routineArguments(command);
  if (args === undefined) return "ask";
  const pathOptions = new Set([
    "config", "configuration", "cwd", "prefix", "directory", "project", "root", "output", "out-dir", "outdir", "cache", "file",
  ]);

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined || arg === "--") continue;
    const equals = arg.match(/^--?([^=]+)=(.*)$/);
    if (equals) {
      const option = equals[1]?.toLowerCase() ?? "";
      const value = equals[2] ?? "";
      if (!pathOptions.has(option)) return "ask";
      const decision = assessArgumentPath(value, cwd, lexicalWorkspace, physicalWorkspace);
      if (decision !== "allow") return decision;
      continue;
    }
    const option = arg.match(/^--?(.+)$/)?.[1]?.toLowerCase();
    if (option !== undefined && pathOptions.has(option)) {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("-")) return "ask";
      const decision = assessArgumentPath(value, cwd, lexicalWorkspace, physicalWorkspace);
      if (decision !== "allow") return decision;
      index += 1;
      continue;
    }
    if (arg.startsWith("-")) continue;
    if (looksLikePath(arg)) {
      const decision = assessArgumentPath(arg, cwd, lexicalWorkspace, physicalWorkspace);
      if (decision !== "allow") return decision;
      continue;
    }
    return "ask";
  }
  return "allow";
}

function routineArguments(command: ParsedCommand): readonly string[] | undefined {
  const first = command.args[0]?.toLowerCase();
  if (["npm", "pnpm", "yarn", "bun"].includes(command.executable)) {
    if (first === "run") return command.args.slice(2);
    return command.args.slice(1);
  }
  if (["cargo", "dotnet", "gradle", "gradlew", "mvn", "go"].includes(command.executable)) return command.args.slice(1);
  if (["pytest", "vitest", "jest", "eslint", "tsc"].includes(command.executable)) return command.args;
  return undefined;
}

function assessArgumentPath(value: string, cwd: string, lexicalWorkspace: string, physicalWorkspace: string): ArgumentDecision {
  if (value.length === 0) return "ask";
  const resolved = resolve(cwd, value);
  const classification = classifyPath(lexicalWorkspace, physicalWorkspace, resolved);
  return classification.escape || !classification.inside ? "deny" : "allow";
}

function looksLikePath(value: string): boolean {
  return isAbsolute(value) || value === "." || value === ".." || value.startsWith("./") || value.startsWith(".\\")
    || value.startsWith("../") || value.startsWith("..\\") || value.includes("/") || value.includes("\\");
}

function assessD2cCommandPaths(command: ParsedCommand, cwd: string, workspace: string, lexicalWorkspace: string): "allow" | "deny" {
  for (const raw of command.args) {
    const value = raw.includes("=") ? raw.slice(raw.indexOf("=") + 1) : raw;
    if (process.platform === "win32" && /^\/[a-z?]+$/i.test(value)) continue;
    if (!(isAbsolute(value) || value === ".." || value.startsWith("../") || value.startsWith("..\\"))) continue;
    const classification = classifyPath(lexicalWorkspace, workspace, resolve(cwd, value));
    if (classification.escape || !classification.inside) return "deny";
  }
  return "allow";
}
