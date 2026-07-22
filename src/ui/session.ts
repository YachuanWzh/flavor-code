import type { AgentEvent } from "../agent/types.js";
import { redactConfig } from "../config/load.js";
import type { HookBus } from "../hooks/bus.js";
import type { PermissionMode } from "../permissions/engine.js";
import type { SkillMetadata } from "../skills/registry.js";
import { parseSlashCommand, type McpSlashCommand, type ModelRole, type SlashCommand } from "./commands.js";
import type { QuestionBridge } from "../tools/ask-user-question.js";
import { message } from "../utils/error.js";

export type SessionOutput = AgentEvent
  | { type: "notice"; message: string }
  | { type: "clear" }
  | { type: "exit" };

export interface SessionServices {
  hooks: HookBus;
  workspace: string;
  mainModel(): string;
  subagentModel(): string;
  permissionMode(): PermissionMode;
  run(prompt: string, signal: AbortSignal): AsyncIterable<AgentEvent>;
  runSkill(skill: string, prompt: string, signal: AbortSignal): AsyncIterable<AgentEvent>;
  runLoop(goal: string, signal: AbortSignal): AsyncIterable<AgentEvent>;
  runGoal(goal: string, signal: AbortSignal): AsyncIterable<AgentEvent>;
  mcp(command: McpSlashCommand, signal: AbortSignal): Promise<string>;
  setModel(role: ModelRole, modelId: string): void | Promise<void>;
  setPermissionMode(mode: PermissionMode): void | Promise<void>;
  compact(signal?: AbortSignal): Promise<boolean>;
  initialize(): Promise<{ path: string; created: boolean }>;
  config(): unknown;
  skills(): Promise<readonly SkillMetadata[]>;
  reloadSkills?(): Promise<void>;
  plugins(): readonly unknown[];
  hooksStatus(): readonly unknown[];
  tasks(): unknown;
  audit(toolFilter?: string): string | Promise<string>;
  cancelActiveTask(): void | Promise<void>;
  clearContext(): void | Promise<void>;
  pluginCommands(): readonly string[];
  runPluginCommand(name: string, args: readonly string[], signal: AbortSignal): Promise<unknown>;
  output(event: SessionOutput): void;
  questions: QuestionBridge;
  login(): Promise<string>;
}

const HELP = [
  "/model <main|subagent> <provider:model>  switch any configured model",
  "/permissions <default|acceptEdits|plan|bypassPermissions|auto|bubble>",
  "/login                                  authenticate via OAuth PKCE",
  "/init  /config  /skills  /plugins  /hooks  /tasks",
  "/compact  /clear  /help  /exit",
  "/loop <goal>                            run a verified autonomous loop",
  "/goal <objective>                       run a goal pipeline with adversarial verification",
  "/mcp [status|tools|reconnect|enable|disable]  manage MCP servers",
].join("\n");

export class FlavorSession {
  readonly #services: SessionServices;
  #active: AbortController | undefined;
  #started = false;
  #closed = false;
  #interrupted = false;
  #startPromise: Promise<void> | undefined;
  #submissionTail: Promise<void> = Promise.resolve();
  #closePromise: Promise<void> | undefined;

  constructor(services: SessionServices) { this.#services = services; }

  get active(): boolean { return this.#active !== undefined; }

  async start(): Promise<void> {
    if (this.#started) return;
    if (this.#closed) throw new Error("Session is closed");
    this.#startPromise ??= this.#services.hooks.emit({
      version: 1, type: "SessionStart", payload: { workspace: this.#services.workspace },
    }).then(() => { this.#started = true; });
    return this.#startPromise;
  }

  async submit(input: string): Promise<void> {
    if (this.#closed) throw new Error("Session is closed");
    const prompt = input.trim();
    if (!prompt) return;
    const operation = this.#submissionTail.catch(() => {}).then(() => this.#runSubmission(prompt));
    this.#submissionTail = operation;
    return operation;
  }

  async #runSubmission(prompt: string): Promise<void> {
    await this.start();
    if (this.#closed) throw new Error("Session is closed");
    const controller = new AbortController();
    this.#active = controller;
    this.#interrupted = false;
    let outcome = "completed";
    try {
      const decision = await this.#services.hooks.emit({
        version: 1, type: "UserPromptSubmit", payload: { prompt },
      }, controller.signal);
      if (decision.decision === "deny") {
        outcome = "denied";
        this.#notice(decision.reason ?? "Prompt denied by hook.");
        return;
      }
      let skillNames: string[] = [];
      if (prompt.startsWith("/")) {
        try { skillNames = (await this.#services.skills()).map(({ name }) => name); }
        catch { /* Built-in and plugin commands remain available when skill discovery fails. */ }
      }
      const command = parseSlashCommand(prompt, this.#services.pluginCommands(), skillNames);
      if (command !== null) await this.#dispatch(command, controller.signal);
      else for await (const event of this.#services.run(prompt, controller.signal)) this.#services.output(event);
      if (controller.signal.aborted) outcome = "cancelled";
    } catch (error) {
      outcome = controller.signal.aborted ? "cancelled" : "failed";
      this.#services.output({ type: "error", error: { code: "unknown", message: message(error) } });
    } finally {
      try {
        if (controller.signal.aborted) {
          try { await this.#services.cancelActiveTask(); }
          catch (error) {
            outcome = "failed";
            try { this.#services.output({ type: "error", error: { code: "unknown", message: message(error) } }); }
            catch { /* Cleanup must still clear active state and emit Stop. */ }
          }
        }
      } finally {
        this.#active = undefined;
        await this.#services.hooks.emit({ version: 1, type: "Stop", payload: { outcome } });
      }
    }
  }

  interrupt(): "cancelled" | "exit" {
    if (this.#active !== undefined && !this.#interrupted) {
      this.#interrupted = true;
      this.#active.abort(new Error("Cancelled by Ctrl+C"));
      return "cancelled";
    }
    this.#services.output({ type: "exit" });
    return "exit";
  }

  async close(): Promise<void> {
    this.#closePromise ??= this.#close();
    return this.#closePromise;
  }

  async #close(): Promise<void> {
    this.#closed = true;
    this.#active?.abort(new Error("Session closed"));
    await this.#submissionTail.catch(() => {});
    await this.#startPromise?.catch(() => {});
    if (this.#started) await this.#services.hooks.emit({
      version: 1, type: "SessionEnd", payload: { workspace: this.#services.workspace },
    });
  }

  async #dispatch(command: SlashCommand, signal: AbortSignal): Promise<void> {
    if (command.name === "unknown") {
      this.#notice(command.suggestions.length
        ? `Unknown command /${command.input}. Try ${command.suggestions.map((item) => `/${item}`).join(", ")}.`
        : `Unknown command /${command.input}. Use /help to list commands.`);
    } else if (command.name === "invalid") this.#notice(command.message);
    else if (command.name === "model") {
      await this.#services.setModel(command.role, command.modelId);
      this.#notice(`${command.role} model set to ${command.modelId}.`);
    } else if (command.name === "permissions") {
      await this.#services.setPermissionMode(command.mode);
      this.#notice(`Main permissions set to ${command.mode}. Child approvals use bubble mode unless plan mode is active.`);
    } else if (command.name === "plugin") {
      this.#notice(format(await this.#services.runPluginCommand(command.command, command.args, signal)));
    } else if (command.name === "skill") {
      for await (const event of this.#services.runSkill(command.skill, command.prompt, signal)) this.#services.output(event);
    } else if (command.name === "loop") {
      for await (const event of this.#services.runLoop(command.goal, signal)) this.#services.output(event);
    } else if (command.name === "goal") {
      for await (const event of this.#services.runGoal(command.goal, signal)) this.#services.output(event);
    } else if (command.name === "mcp") {
      this.#notice(await this.#services.mcp(command, signal));
    } else if (command.name === "compact") {
      this.#notice(await this.#services.compact(signal) ? "Context compacted." : "Context does not need compaction.");
    } else if (command.name === "init") {
      const result = await this.#services.initialize();
      this.#notice(`${result.created ? "Created" : "Updated"} ${result.path}.`);
    } else if (command.name === "config") this.#notice(format(redactConfig(this.#services.config())));
    else if (command.name === "skills") this.#notice(format(await this.#services.skills()));
    else if (command.name === "plugins") this.#notice(format(this.#services.plugins()));
    else if (command.name === "hooks") this.#notice(format(this.#services.hooksStatus()));
    else if (command.name === "tasks") this.#notice(format(this.#services.tasks()));
    else if (command.name === "audit") this.#notice(await this.#services.audit(command.toolFilter));
    else if (command.name === "clear") {
      await this.#services.clearContext();
      this.#services.output({ type: "clear" });
    }
    else if (command.name === "login") {
      this.#notice("Opening browser for authentication...");
      this.#notice(await this.#services.login());
    }
    else if (command.name === "help") this.#notice(HELP);
    else if (command.name === "exit") this.#services.output({ type: "exit" });
  }

  #notice(message: string): void { this.#services.output({ type: "notice", message }); }
}

function format(value: unknown): string {
  if (Array.isArray(value) && value.length === 0) return "None registered.";
  return JSON.stringify(value, null, 2) ?? String(value);
}

