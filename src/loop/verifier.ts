import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { createShellTool } from "../tools/shell.js";
import type { LoopVerificationEvidence } from "./types.js";

export interface VerificationCommand {
  label: string;
  command: string;
  args: string[];
}

export interface VerificationPlan {
  commands: VerificationCommand[];
  needsHumanReason?: string;
}

const SCRIPT_PRIORITY = ["test", "typecheck", "lint", "build", "smoke:install"] as const;

export async function inferVerificationPlan(workspace: string): Promise<VerificationPlan> {
  const commands: VerificationCommand[] = [];
  const seen = new Set<string>();
  const packageJson = await optionalJson(join(workspace, "package.json"));
  const scripts = isRecord(packageJson?.scripts) ? packageJson.scripts : {};
  for (const name of SCRIPT_PRIORITY) {
    if (typeof scripts[name] !== "string" || isUnconditionalPassThrough(scripts[name])) continue;
    add(commands, seen, npmScript(name));
  }

  const flavor = await optionalText(join(workspace, "FLAVOR.md"));
  if (flavor !== undefined) {
    for (const match of flavor.matchAll(/^- `([^`]+)`\s*$/gm)) {
      const parsed = parseTrustedCommand(match[1] ?? "");
      if (parsed !== undefined) add(commands, seen, parsed);
    }
  }

  commands.sort((left, right) => priority(left.label) - priority(right.label));
  return commands.length > 0
    ? { commands }
    : { commands, needsHumanReason: "No deterministic verification command was found." };
}

export async function runVerificationPlan(
  plan: VerificationPlan,
  workspace: string,
  signal: AbortSignal,
): Promise<LoopVerificationEvidence> {
  signal.throwIfAborted();
  if (plan.commands.length === 0) {
    return { passed: false, commands: [], summary: plan.needsHumanReason ?? "No verification commands were configured." };
  }
  const shell = createShellTool(workspace);
  const commands: LoopVerificationEvidence["commands"] = [];
  for (const item of plan.commands) {
    signal.throwIfAborted();
    const result = await shell.execute({ command: item.command, args: item.args, cwd: null, timeoutMs: 600_000 }, signal);
    commands.push({
      command: item.command,
      args: item.args,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      truncated: result.truncated,
    });
    if (result.exitCode !== 0) {
      return { passed: false, commands, summary: `${item.label} failed with exit code ${String(result.exitCode)}.` };
    }
  }
  return { passed: true, commands, summary: `Passed ${commands.length} deterministic verification command(s).` };
}

function npmScript(name: string): VerificationCommand {
  return name === "test"
    ? { label: name, command: "npm", args: ["test"] }
    : { label: name, command: "npm", args: ["run", name] };
}

function parseTrustedCommand(value: string): VerificationCommand | undefined {
  const parts = value.trim().split(/\s+/);
  const [command, ...args] = parts;
  if (command !== "npm") return undefined;
  if (args.length === 1 && args[0] === "test") return { label: "test", command, args };
  if (args.length === 2 && args[0] === "run" && SCRIPT_PRIORITY.includes(args[1] as typeof SCRIPT_PRIORITY[number])) {
    return { label: args[1]!, command, args };
  }
  return undefined;
}

function add(commands: VerificationCommand[], seen: Set<string>, command: VerificationCommand): void {
  const key = [command.command, ...command.args].join("\0");
  if (seen.has(key)) return;
  seen.add(key);
  commands.push(command);
}

function priority(label: string): number {
  const index = SCRIPT_PRIORITY.indexOf(label as typeof SCRIPT_PRIORITY[number]);
  return index < 0 ? SCRIPT_PRIORITY.length : index;
}

function isUnconditionalPassThrough(script: string): boolean {
  const value = script.trim();
  if (/^(?:true|exit\s+0)$/i.test(value)) return true;
  if (/^(?:echo|printf)(?:\s|$)/i.test(value) && !/[&|;]/.test(value)) return true;
  return /^(?:node|bun|deno)\s+(?:-e|--eval)\s+["'`]\s*(?:process\.)?exit\(0\);?\s*["'`]$/i.test(value);
}

async function optionalText(path: string): Promise<string | undefined> {
  try { return await readFile(path, "utf8"); }
  catch (error) { if (isCode(error, "ENOENT")) return undefined; throw error; }
}

async function optionalJson(path: string): Promise<Record<string, unknown> | undefined> {
  const raw = await optionalText(path);
  if (raw === undefined) return undefined;
  const parsed: unknown = JSON.parse(raw);
  return isRecord(parsed) ? parsed : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
