export const MVP_COMMANDS = [
  "model", "init", "config", "permissions", "skills", "plugins", "hooks",
  "tasks", "compact", "clear", "help", "exit",
] as const;

export type PermissionCommandMode = "safe" | "workspace" | "full";
export type ModelRole = "main" | "subagent";

export type SlashCommand =
  | { name: "model"; role: ModelRole; modelId: string }
  | { name: "permissions"; mode: PermissionCommandMode }
  | { name: "plugin"; command: string; args: string[] }
  | { name: "skill"; skill: string; prompt: string }
  | { name: Exclude<(typeof MVP_COMMANDS)[number], "model" | "permissions"> }
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
    if ((mode !== "safe" && mode !== "workspace" && mode !== "full") || extra.length > 0) {
      return { name: "invalid", command: name, message: "Use /permissions <safe|workspace|full>." };
    }
    return { name, mode };
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
