export const MVP_COMMANDS = [
  "model", "init", "config", "login", "permissions", "skills", "plugins", "hooks",
  "tasks", "finish", "compact", "clear", "help", "exit", "audit", "usage",
  "loop", "goal", "evolve", "mcp",
  "commit", "review",
  "ide",
  "memory", "remember", "forget", "forget-cold",
  "checkpoint", "tree", "rewind", "unrevert", "fork",
  "pals", "chat", "co-work",
] as const;

export const COMMAND_DESCRIPTIONS: Record<(typeof MVP_COMMANDS)[number], string> = {
  model: "Switch the active model",
  init: "Initialize Flavor project files",
  config: "Show the resolved configuration",
  login: "Authenticate via OAuth PKCE",
  permissions: "Change the tool permission mode",
  skills: "List discovered skills",
  plugins: "List loaded plugins",
  hooks: "Show plugin hook status",
  tasks: "Show task planning status",
  finish: "Complete this task and evaluate long-term memory",
  compact: "Compact the conversation context",
  clear: "Clear the transcript",
  help: "Show available commands",
  exit: "Exit Flavor",
  audit: "Query tool failure audit log",
  usage: "Show cache hit statistics for this session",
  loop: "Run a verified autonomous loop toward a goal",
  goal: "Run a goal pipeline with adversarial verification",
  evolve: "Self-improvement loop: capture failures, suggest fixes, verify with tests",
  commit: "Generate a commit message for staged changes and commit after confirmation",
  review: "Review uncommitted changes for bugs and risks before committing",
  mcp: "Manage MCP servers",
  ide: "Show the connected IDE and editor context",
  memory: "Show long-term project memory",
  remember: "Add a long-term memory",
  forget: "Remove matching long-term memories",
  "forget-cold": "Remove all cold long-term memories and their files",
  checkpoint: "Create a workspace and context checkpoint",
  tree: "Show the session history tree",
  rewind: "Restore a prior session node",
  unrevert: "Undo the most recent rewind",
  fork: "Continue context from a prior session node",
  pals: "List, rename, or inspect active Flavor pals",
  chat: "Send a task to another Flavor pal",
  "co-work": "Coordinate a shared goal with another Flavor pal",
};

export type PermissionCommandMode = PermissionMode;
export type ModelRole = "main" | "subagent";
export type McpSlashCommand =
  | { name: "mcp"; action: "status" }
  | { name: "mcp"; action: "tools" | "reconnect"; target: string }
  | { name: "mcp"; action: "enable" | "disable"; target: string };

export type PalsSlashCommand =
  | { name: "pals"; action: "list"; verbose: boolean }
  | { name: "pals"; action: "rename"; alias: string }
  | { name: "pals"; action: "info"; target: string };

export type CoWorkSlashCommand =
  | { name: "co-work"; action: "start"; target: string; goal: string }
  | { name: "co-work"; action: "status"; coWorkId?: string }
  | { name: "co-work"; action: "cancel"; coWorkId: string; reason?: string };

export type SlashCommand =
  | { name: "model"; role: ModelRole; modelId: string }
  | { name: "permissions"; mode: PermissionCommandMode }
  | { name: "plugin"; command: string; args: string[] }
  | { name: "skill"; skill: string; prompt: string }
  | { name: "loop"; goal: string }
  | { name: "goal"; goal: string }
  | { name: "commit"; hint?: string }
  | { name: "review"; focus?: string }
  | { name: "remember"; type: MemoryType; text: string }
  | { name: "forget"; query: string }
  | { name: "checkpoint"; label?: string }
  | { name: "rewind" | "fork"; nodeId: string }
  | McpSlashCommand
  | PalsSlashCommand
  | { name: "chat"; target: string; goal: string }
  | CoWorkSlashCommand
  | { name: Exclude<(typeof MVP_COMMANDS)[number], "model" | "permissions" | "audit" | "loop" | "goal" | "evolve" | "commit" | "review" | "mcp" | "remember" | "forget" | "checkpoint" | "rewind" | "fork" | "pals" | "chat" | "co-work"> }
  | { name: "audit"; toolFilter?: string | undefined }
  | { name: "evolve"; args: string[] }
  | { name: "unknown"; input: string; suggestions: string[] }
  | { name: "invalid"; command: string; message: string };

export function parseSlashCommand(
  input: string,
  dynamicCommands: readonly string[] = [],
  skillCommands: readonly string[] = [],
): SlashCommand | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) return null;
  const [rawName = "", ...args] = trimmed.slice(1).split(/\s+/);
  const name = rawName.toLowerCase();
  if (!(MVP_COMMANDS as readonly string[]).includes(name) && dynamicCommands.includes(name)) {
    return { name: "plugin", command: name, args };
  }
  if (!(MVP_COMMANDS as readonly string[]).includes(name) && skillCommands.includes(name)) {
    return { name: "skill", skill: name, prompt: args.join(" ") };
  }
  if (!(MVP_COMMANDS as readonly string[]).includes(name)) {
    return { name: "unknown", input: rawName, suggestions: suggestionsFor(name) };
  }
  if (name === "model") {
    const [role, modelId, ...extra] = args;
    if ((role !== "main" && role !== "subagent") || !modelId || extra.length > 0 || !modelId.includes(":")) {
      return { name: "invalid", command: name, message: "Use /model <main|subagent> <provider:model>." };
    }
    return { name, role, modelId };
  }
  if (name === "permissions") {
    const [mode, ...extra] = args;
    const normalized = normalizePermissionMode(mode);
    if (typeof normalized !== "string" || !(PERMISSION_MODES as readonly string[]).includes(normalized) || extra.length > 0) {
      return { name: "invalid", command: name, message: `Use /permissions <${PERMISSION_MODES.join("|")}>.` };
    }
    return { name, mode: normalized as PermissionMode };
  }
  if (name === "audit") {
    const toolFilter = args.length > 0 ? args.join(" ") : undefined;
    return { name, toolFilter };
  }
  if (name === "evolve") {
    return { name, args };
  }
  if (name === "commit") {
    const hint = args.join(" ").trim();
    return hint.length === 0 ? { name } : { name, hint };
  }
  if (name === "review") {
    const focus = args.join(" ").trim();
    return focus.length === 0 ? { name } : { name, focus };
  }
  if (name === "loop") {
    const goal = args.join(" ").trim();
    if (!goal) return { name: "invalid", command: name, message: "Use /loop <goal>." };
    return { name, goal };
  }
  if (name === "goal") {
    const goal = args.join(" ").trim();
    if (!goal) return { name: "invalid", command: name, message: "Use /goal <objective>." };
    return { name, goal };
  }
  if (name === "remember") {
    const usage = "Use /remember [user|feedback|project|reference] <text>.";
    if (args.length === 0) return { name: "invalid", command: name, message: usage };
    const explicitType = (MEMORY_TYPES as readonly string[]).includes(args[0] ?? "");
    const type = explicitType ? args[0] as MemoryType : "project";
    const text = args.slice(explicitType ? 1 : 0).join(" ").trim();
    return text.length === 0 ? { name: "invalid", command: name, message: usage } : { name, type, text };
  }
  if (name === "forget") {
    const query = args.join(" ").trim();
    return query.length === 0
      ? { name: "invalid", command: name, message: "Use /forget <text-or-id>." }
      : { name, query };
  }
  if (name === "checkpoint") {
    const label = args.join(" ").trim();
    return label.length === 0 ? { name } : { name, label };
  }
  if (name === "rewind" || name === "fork") {
    const [nodeId, ...extra] = args;
    return nodeId === undefined || extra.length > 0
      ? { name: "invalid", command: name, message: `Use /${name} <node-id>.` }
      : { name, nodeId };
  }
  if (name === "mcp") {
    const usage = "Use /mcp [status|tools <server>|reconnect <server>|enable [server|all]|disable [server|all]].";
    const [action, target, ...extra] = args;
    if (action === undefined || (action === "status" && target === undefined)) return { name, action: "status" };
    if ((action === "tools" || action === "reconnect") && target !== undefined && extra.length === 0) {
      return { name, action, target };
    }
    if ((action === "enable" || action === "disable") && extra.length === 0) {
      return { name, action, target: target ?? "all" };
    }
    return { name: "invalid", command: name, message: usage };
  }
  if (name === "pals") {
    const usage = "Use /pals [--verbose|rename <alias>|info <alias-or-uuid>].";
    if (args.length === 0) return { name, action: "list", verbose: false };
    if (args.length === 1 && args[0] === "--verbose") return { name, action: "list", verbose: true };
    if (args.length === 2 && args[0] === "rename" && validTarget(args[1])) {
      return { name, action: "rename", alias: args[1] };
    }
    if (args.length === 2 && args[0] === "info" && validTarget(args[1])) {
      return { name, action: "info", target: args[1] };
    }
    return { name: "invalid", command: name, message: usage };
  }
  if (name === "chat") {
    const [target, ...goalParts] = args;
    const goal = goalParts.join(" ").trim();
    return !validTarget(target) || !validText(goal)
      ? { name: "invalid", command: name, message: "Use /chat <alias-or-uuid> <goal>." }
      : { name, target, goal };
  }
  if (name === "co-work") {
    const usage = "Use /co-work <alias-or-uuid> <goal> | status [id] | cancel <id> [reason].";
    const [first, second, ...rest] = args;
    if (first === "status") {
      if (rest.length > 0 || (second !== undefined && !validTarget(second))) {
        return { name: "invalid", command: name, message: usage };
      }
      return second === undefined ? { name, action: "status" } : { name, action: "status", coWorkId: second };
    }
    if (first === "cancel") {
      const reason = rest.join(" ").trim();
      if (!validTarget(second) || (reason.length > 0 && !validText(reason))) {
        return { name: "invalid", command: name, message: usage };
      }
      return reason.length === 0
        ? { name, action: "cancel", coWorkId: second }
        : { name, action: "cancel", coWorkId: second, reason };
    }
    const goal = [second, ...rest].filter((item): item is string => item !== undefined).join(" ").trim();
    return !validTarget(first) || !validText(goal)
      ? { name: "invalid", command: name, message: usage }
      : { name, action: "start", target: first, goal };
  }
  if (args.length > 0) return { name: "invalid", command: name, message: `/${name} does not accept arguments.` };
  return { name } as SlashCommand;
}

function validTarget(value: string | undefined): value is string {
  return value !== undefined && value.length > 0 && value.length <= MAX_ALIAS_LENGTH;
}

function validText(value: string): boolean {
  return value.length > 0 && Buffer.byteLength(value, "utf8") <= MAX_MESSAGE_BYTES;
}

function suggestionsFor(input: string): string[] {
  return MVP_COMMANDS
    .map((command) => ({ command, distance: editDistance(input, command) }))
    .filter(({ distance }) => distance <= Math.max(2, Math.floor(input.length / 3)))
    .sort((left, right) => left.distance - right.distance || left.command.localeCompare(right.command))
    .slice(0, 3)
    .map(({ command }) => command);
}

function editDistance(left: string, right: string): number {
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      current[rightIndex] = Math.min(
        (current[rightIndex - 1] ?? 0) + 1,
        (previous[rightIndex] ?? 0) + 1,
        (previous[rightIndex - 1] ?? 0) + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[right.length] ?? left.length;
}
import { normalizePermissionMode, PERMISSION_MODES, type PermissionMode } from "../config/schema.js";
import { MEMORY_TYPES, type MemoryType } from "../memory/types.js";
import { MAX_ALIAS_LENGTH, MAX_MESSAGE_BYTES } from "../pals/protocol.js";
