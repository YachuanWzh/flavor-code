import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { SubagentResultSchema, SubagentScheduler, type SubagentResult } from "./agent/subagents.js";
import { TaskGraphSchema, TaskPlanner, type TaskNode } from "./agent/planner.js";
import type { AgentEvent } from "./agent/types.js";
import { loadConfig } from "./config/load.js";
import { ContextManager } from "./context/manager.js";
import { LocalHarness } from "./harness/local.js";
import { HookBus } from "./hooks/bus.js";
import { HOOK_EVENT_NAMES, type HookEventName } from "./hooks/types.js";
import { initializeFlavor } from "./init/project.js";
import { AnthropicModelAdapter } from "./models/anthropic.js";
import { OpenAIModelAdapter } from "./models/openai.js";
import { ModelRegistry } from "./models/registry.js";
import type { ModelAdapter } from "./models/types.js";
import type { PermissionRequest } from "./permissions/engine.js";
import { PluginHost } from "./plugins/host.js";
import { SkillRegistry } from "./skills/registry.js";
import { createApplyPatchTool, createEditTool, createReadTool, createWriteTool } from "./tools/files.js";
import { createGlobTool, createGrepTool } from "./tools/search.js";
import { createShellTool } from "./tools/shell.js";
import type { ToolDefinition } from "./tools/types.js";
import { FlavorSession, type SessionOutput, type SessionServices } from "./ui/session.js";

export interface ProductionRuntimeOptions {
  workspace?: string;
  home?: string;
  environment?: NodeJS.ProcessEnv;
  output(event: SessionOutput): void;
  onApprovalChange?(): void;
  /** Non-interactive callers must deny requests instead of waiting for input. */
  approvalPolicy?: "prompt" | "deny";
}

export interface ProductionRuntime {
  session: FlavorSession;
  services: SessionServices;
  approvals: ApprovalBridge;
  diagnostics: readonly string[];
  dispose(): Promise<void>;
}

export class ApprovalBridge {
  #pending: (PermissionRequest & { reason?: string }) | undefined;
  #settle: ((approved: boolean) => void) | undefined;
  readonly #onChange: (() => void) | undefined;

  constructor(onChange?: () => void) { this.#onChange = onChange; }
  get pending(): (PermissionRequest & { reason?: string }) | undefined { return this.#pending; }

  request(request: PermissionRequest & { reason?: string }): Promise<boolean> {
    if (this.#settle !== undefined) return Promise.resolve(false);
    this.#pending = request;
    this.#onChange?.();
    return new Promise<boolean>((resolvePromise) => { this.#settle = resolvePromise; });
  }

  resolve(approved: boolean): void {
    const settle = this.#settle;
    this.#settle = undefined;
    this.#pending = undefined;
    settle?.(approved);
    this.#onChange?.();
  }
}

export async function createProductionRuntime(options: ProductionRuntimeOptions): Promise<ProductionRuntime> {
  const workspace = resolve(options.workspace ?? process.cwd());
  const home = resolve(options.home ?? homedir());
  const environment = options.environment ?? process.env;
  const loaded = await loadConfig({ cwd: workspace, home });
  const config = loaded.config;
  const secrets = [
    ...Object.values(config.providers).map((provider) => provider.apiKey),
    environment.OPENAI_API_KEY, environment.ANTHROPIC_API_KEY,
  ].filter((value): value is string => typeof value === "string" && value.length > 0);
  const hooks = new HookBus();
  const registry = new ModelRegistry();
  const diagnostics: string[] = [];
  const approvals = new ApprovalBridge(options.onApprovalChange);
  const tools: ToolDefinition<unknown>[] = [
    createReadTool(workspace), createWriteTool(workspace), createEditTool(workspace), createApplyPatchTool(workspace),
    createGlobTool(workspace), createGrepTool(workspace), createShellTool(workspace),
  ];
  const pluginSkillRoots: string[] = [];
  const pluginHooks: HookEventName[] = [];

  registerConfiguredAdapters(config.providers, registry, environment, diagnostics);

  const pluginHost = new PluginHost({
    globalPluginDirs: [join(home, ".flavor-code", "plugins")],
    projectPluginDirs: [join(workspace, ".flavor", "plugins")],
    config,
    registrations: {
      command(name) {
        diagnostics.push(`Plugin command "${name}" is unsupported by the closed MVP command parser.`);
        return () => {};
      },
      tool(name, tool) {
        if (tools.some((candidate) => candidate.name === tool.name)) throw new Error(`Tool contribution "${name}" conflicts with ${tool.name}`);
        tools.push(tool); return () => { remove(tools, tool); };
      },
      hook(name, hook, hookOptions) {
        pluginHooks.push(name);
        const dispose = hooks.on(name, hook, hookOptions);
        return () => { dispose(); remove(pluginHooks, name); };
      },
      skillRoot(_name, capability) {
        pluginSkillRoots.push(capability.path);
        return () => { remove(pluginSkillRoots, capability.path); };
      },
      modelAdapter(name, adapter) {
        if (registry.has(name)) throw new Error(`Model adapter contribution conflicts with provider "${name}"`);
        registry.register(name, adapter); return () => { registry.unregister(name, adapter); };
      },
    },
    emitLifecycle: async (type, plugin) => { await hooks.emit({ version: 1, type, payload: { name: plugin.name, version: plugin.version } }); },
  });
  await pluginHost.loadAll();

  const skills = new SkillRegistry({
    globalRoots: [join(home, ".flavor-code", "skills")],
    projectRoots: [join(workspace, ".flavor", "skills"), ...pluginSkillRoots],
  });
  await skills.discover();
  const flavor = await optionalText(join(workspace, "FLAVOR.md"));
  const mainModel = config.agents?.main.model ?? defaultModel(registry, environment);
  const childModel = config.agents?.subagent.model ?? mainModel;
  let harness!: LocalHarness;
  let taskResults: SubagentResult[] = [];

  const taskTool: ToolDefinition<unknown> = {
    name: "Task",
    description: "Validate a task graph and execute its nodes with isolated child agents",
    inputSchema: TaskGraphSchema,
    paths: () => [],
    execute: async (input, signal) => {
      const graph = await new TaskPlanner({ hooks }).plan(input, signal);
      taskResults = [];
      const scheduler = new SubagentScheduler({
        hooks,
        maxSubagents: config.maxSubagents,
        onResult: (result) => { taskResults.push(result); },
        execute: (task, execution) => runChild(harness, skills, task, execution.attempt, execution.signal),
      });
      return scheduler.run(graph, signal);
    },
  };
  tools.push(taskTool);

  const createContext = () => new ContextManager({
    system: "You are Flavor, a coding agent. Report conclusions and actions; never expose hidden chain-of-thought.",
    ...(flavor === undefined ? {} : { flavor }),
    compactAtChars: config.context.compactAtChars,
    toolOutputChars: config.context.toolOutputChars,
    summarize: async (messages) => messages.map((item) => `${item.role}: ${item.content}`).join("\n").slice(-40_000),
    hooks,
  });
  harness = new LocalHarness({
    registry, hooks, workspace, mainModelId: mainModel, subagentModelId: childModel,
    tools, createContext, permissionMode: config.permissionMode,
    approve: options.approvalPolicy === "deny" ? () => false : (request) => approvals.request(request),
  });

  const services: SessionServices = {
    hooks, workspace,
    mainModel: () => harness.mainModelId,
    subagentModel: () => harness.subagentModelId,
    permissionMode: () => harness.permissionMode,
    run: (prompt, signal) => runMain(harness, skills, prompt, signal),
    setModel: (role, id) => harness.setModel(role, id),
    setPermissionMode: (mode) => harness.setPermissionMode(mode),
    compact: (signal) => harness.main.context.compact(signal),
    initialize: () => initializeFlavor(workspace),
    config: () => ({
      ...config, sources: loaded.sources,
      diagnostics: [...diagnostics, ...pluginHost.diagnostics.map((item) => `${item.plugin}: ${item.message}`),
        ...skills.diagnostics.map((item) => `${item.path}: ${item.message}`)].map((item) => redactDiagnostic(item, secrets)),
    }),
    skills: () => skills.discover(),
    plugins: () => pluginHost.loadedPlugins,
    hooksStatus: () => HOOK_EVENT_NAMES.map((name) => ({ name, pluginHandlers: pluginHooks.filter((item) => item === name).length })),
    tasks: () => taskResults,
    output: options.output,
  };
  const session = new FlavorSession(services);
  return {
    session, services, approvals, diagnostics,
    async dispose() { approvals.resolve(false); await pluginHost.unloadAll(); },
  };
}

async function* runMain(harness: LocalHarness, skills: SkillRegistry, prompt: string, signal: AbortSignal): AsyncIterable<AgentEvent> {
  let additionalContext: string | undefined;
  try {
    const skill = await skills.match(prompt);
    if (skill !== undefined) additionalContext = `Matched skill: ${skill.name}\n${await skills.loadBody(skill)}`;
    for await (const event of harness.main.loop.run({ prompt, signal, ...(additionalContext ? { additionalContext } : {}) })) {
      if (event.type === "error" && /adapter|provider|api.?key|model/i.test(event.error.message)) {
        yield { ...event, error: { ...event.error,
          message: `${event.error.message}. Configure providers and agents in .flavor/flavor.json or set OPENAI_API_KEY/ANTHROPIC_API_KEY.`,
        } };
      } else yield event;
    }
  } catch (error) {
    const detail = message(error);
    const setup = /adapter|provider|api.?key|model/i.test(detail)
      ? `${detail}. Configure providers and agents in .flavor/flavor.json or set OPENAI_API_KEY/ANTHROPIC_API_KEY.`
      : detail;
    yield { type: "error", error: { code: "unknown", message: setup } };
  }
}

async function runChild(
  harness: LocalHarness, skills: SkillRegistry, task: TaskNode, attempt: 1 | 2, signal: AbortSignal,
): Promise<unknown> {
  return harness.runSubagent(task, async (child, childSignal) => {
    const skill = await skills.match(task.description);
    const additionalContext = skill === undefined ? undefined : `Matched skill: ${skill.name}\n${await skills.loadBody(skill)}`;
    const repair = attempt === 2 ? " Your previous response was invalid. Return only one strict JSON object." : "";
    const prompt = [
      `Complete task ${task.id}: ${task.description}`,
      `Expected outputs: ${task.expectedOutputs.join("; ")}`,
      `Verification: ${task.verification.join("; ")}`,
      `Return only JSON matching these fields: ${Object.keys(SubagentResultSchema.shape).join(", ")}.${repair}`,
    ].join("\n");
    let text = "";
    for await (const event of child.loop.run({ prompt, signal: childSignal, ...(additionalContext ? { additionalContext } : {}) })) {
      if (event.type === "text") text += event.text;
      if (event.type === "error") throw new Error(event.error.message);
    }
    try { return JSON.parse(text.trim()) as unknown; }
    catch { return text; }
  }, signal);
}

function registerConfiguredAdapters(
  providers: Record<string, { type: string; apiKey?: string | undefined; baseURL?: string | undefined }>,
  registry: ModelRegistry,
  environment: NodeJS.ProcessEnv,
  diagnostics: string[],
): void {
  const configured = { ...providers };
  if (configured.openai === undefined && environment.OPENAI_API_KEY) configured.openai = { type: "openai", apiKey: environment.OPENAI_API_KEY };
  if (configured.anthropic === undefined && environment.ANTHROPIC_API_KEY) configured.anthropic = { type: "anthropic", apiKey: environment.ANTHROPIC_API_KEY };
  for (const [name, provider] of Object.entries(configured)) {
    try {
      let adapter: ModelAdapter;
      const adapterOptions = {
        ...(provider.apiKey === undefined ? {} : { apiKey: provider.apiKey }),
        ...(provider.baseURL === undefined ? {} : { baseURL: provider.baseURL }),
      };
      if (provider.type === "anthropic") adapter = new AnthropicModelAdapter(adapterOptions);
      else if (provider.type === "openai" || provider.type === "openai-compatible") adapter = new OpenAIModelAdapter(adapterOptions);
      else { diagnostics.push(`Provider "${name}" has unsupported type "${provider.type}".`); continue; }
      registry.register(name, adapter);
    } catch (error) { diagnostics.push(`Provider "${name}" could not start: ${message(error)}`); }
  }
}

function defaultModel(_registry: ModelRegistry, environment: NodeJS.ProcessEnv): string {
  return environment.ANTHROPIC_API_KEY && !environment.OPENAI_API_KEY ? "anthropic:claude-sonnet-4-5" : "openai:gpt-5";
}

async function optionalText(path: string): Promise<string | undefined> {
  try { return await readFile(path, "utf8"); }
  catch (error) { if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return undefined; throw error; }
}

function remove<T>(items: T[], item: T): void { const index = items.indexOf(item); if (index >= 0) items.splice(index, 1); }
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function redactDiagnostic(input: string, secrets: readonly string[]): string {
  return secrets.reduce((text, secret) => text.replaceAll(secret, "[redacted]"), input);
}
