export const MVP_COMMANDS = [
  "model", "init", "config", "login", "permissions", "skills", "plugins", "hooks",
  "tasks", "compact", "clear", "help", "exit", "audit",
  "loop", "goal", "mcp",
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
  compact: "Compact the conversation context",
  clear: "Clear the transcript",
  help: "Show available commands",
  exit: "Exit Flavor",
  audit: "Query tool failure audit log",
  loop: "Run a verified autonomous loop toward a goal",
  goal: "Run a goal pipeline with adversarial verification",
  mcp: "Manage MCP servers",
};

export type PermissionCommandMode = PermissionMode;
export type ModelRole = "main" | "subagent";
export type McpSlashCommand =
  | { name: "mcp"; action: "status" }
  | { name: "mcp"; action: "tools" | "reconnect"; target: string }
  | { name: "mcp"; action: "enable" | "disable"; target: string };

export type SlashCommand =
  | { name: "model"; role: ModelRole; modelId: string }
  | { name: "permissions"; mode: PermissionCommandMode }
  | { name: "plugin"; command: string; args: string[] }
  | { name: "skill"; skill: string; prompt: string }
  | { name: "loop"; goal: string }
  | { name: "goal"; goal: string }
  | McpSlashCommand
  | { name: Exclude<(typeof MVP_COMMANDS)[number], "model" | "permissions" | "audit" | "loop" | "goal" | "mcp"> }
  | { name: "audit"; toolFilter?: string | undefined }
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
  if (name !== "ide" && !(MVP_COMMANDS as readonly string[]).includes(name) && dynamicCommands.includes(name)) {
    return { name: "plugin", command: name, args };
  }
  if (name !== "ide" && !(MVP_COMMANDS as readonly string[]).includes(name) && skillCommands.includes(name)) {
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
  if (args.length > 0) return { name: "invalid", command: name, message: `/${name} does not accept arguments.` };
  return { name } as SlashCommand;
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
