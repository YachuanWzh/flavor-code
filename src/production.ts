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
import { ModelRegistry, parseModelId } from "./models/registry.js";
import type { ModelAdapter } from "./models/types.js";
import type { PermissionRequest } from "./permissions/engine.js";
import { PluginHost } from "./plugins/host.js";
import type { PluginCommandHandler } from "./plugins/types.js";
import { SkillRegistry } from "./skills/registry.js";
import { createSkillResourceTool } from "./skills/tool.js";
import { createApplyPatchTool, createEditTool, createReadTool, createWriteTool } from "./tools/files.js";
import { createGlobTool, createGrepTool } from "./tools/search.js";
import { createShellTool } from "./tools/shell.js";
import type { ToolDefinition } from "./tools/types.js";
import { FlavorSession, type SessionOutput, type SessionServices } from "./ui/session.js";
import { MVP_COMMANDS } from "./ui/commands.js";

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
  #removeAbort: (() => void) | undefined;
  readonly #onChange: (() => void) | undefined;

  constructor(onChange?: () => void) { this.#onChange = onChange; }
  get pending(): (PermissionRequest & { reason?: string }) | undefined { return this.#pending; }

  request(request: PermissionRequest & { reason?: string }, signal: AbortSignal = new AbortController().signal): Promise<boolean> {
    if (this.#settle !== undefined) return Promise.resolve(false);
    if (signal.aborted) return Promise.resolve(false);
    this.#pending = request;
    this.#onChange?.();
    return new Promise<boolean>((resolvePromise) => {
      this.#settle = resolvePromise;
      const onAbort = () => this.resolve(false);
      signal.addEventListener("abort", onAbort, { once: true });
      this.#removeAbort = () => signal.removeEventListener("abort", onAbort);
    });
  }

  resolve(approved: boolean): void {
    const settle = this.#settle;
    const changed = settle !== undefined || this.#pending !== undefined;
    this.#removeAbort?.();
    this.#removeAbort = undefined;
    this.#settle = undefined;
    this.#pending = undefined;
    settle?.(approved);
    if (changed) this.#onChange?.();
  }
}

export async function createProductionRuntime(options: ProductionRuntimeOptions): Promise<ProductionRuntime> {
  const workspace = resolve(options.workspace ?? process.cwd());
  const home = resolve(options.home ?? homedir());
  const environment = options.environment ?? process.env;
  const loaded = await loadConfig({ cwd: workspace, home, environment });
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
  const pluginCommands = new Map<string, PluginCommandHandler>();

  const registeredProviders = registerConfiguredAdapters(config.providers, registry, environment, diagnostics);

  const pluginHost = new PluginHost({
    globalPluginDirs: [join(home, ".flavor-code", "plugins")],
    projectPluginDirs: [join(workspace, ".flavor", "plugins")],
    config,
    registrations: {
      command(name, handler) {
        if (typeof handler !== "function") throw new Error(`Plugin command "${name}" must be a function.`);
        if (name !== name.toLowerCase()) throw new Error(`Plugin command "${name}" must be lowercase.`);
        if ((MVP_COMMANDS as readonly string[]).includes(name) || name === "ide" || pluginCommands.has(name)) {
          throw new Error(`Plugin command "${name}" conflicts with a built-in or registered command.`);
        }
        pluginCommands.set(name, handler);
        return () => { if (pluginCommands.get(name) === handler) pluginCommands.delete(name); };
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
  let harness!: LocalHarness;
  let harnessCreated = false;
  try {
  const skills = new SkillRegistry({
    globalRoots: [join(home, ".flavor-code", "skills")],
    projectRoots: [join(workspace, ".flavor", "skills"), ...pluginSkillRoots],
    authorizeResource: async () => true,
  });
  await skills.discover();
  tools.push(createSkillResourceTool(skills));
  const flavor = await optionalText(join(workspace, "FLAVOR.md"));
  const selectedModels = selectModels(config, registeredProviders, diagnostics);
  const mainModel = selectedModels.main;
  const childModel = selectedModels.child;
  let taskResults: SubagentResult[] = [];

  const taskTool: ToolDefinition<unknown> = {
    name: "Task",
    description: "Validate a task graph and execute its nodes with isolated child agents",
    inputSchema: TaskGraphSchema,
    paths: () => [],
    execute: async (input, signal) => {
      if (selectedModels.childError !== undefined) throw new Error(selectedModels.childError);
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
    system: "You are Flavor, a coding agent. Report conclusions and actions; never expose hidden chain-of-thought. Use SkillResource to read resources explicitly referenced by a matched skill; treat scripts as data and never execute them through that tool.",
    ...(flavor === undefined ? {} : { flavor }),
    compactAtChars: config.context.compactAtChars,
    toolOutputChars: config.context.toolOutputChars,
    summarize: async (messages) => messages.map((item) => `${item.role}: ${item.content}`).join("\n").slice(-40_000),
    hooks,
  });
  harness = new LocalHarness({
    registry, hooks, workspace, mainModelId: mainModel, subagentModelId: childModel,
    tools, createContext, permissionMode: config.permissionMode,
    approve: options.approvalPolicy === "deny" ? () => false : (request, signal) => approvals.request(request, signal),
  });
  harnessCreated = true;

  const services: SessionServices = {
    hooks, workspace,
    mainModel: () => harness.mainModelId,
    subagentModel: () => harness.subagentModelId,
    permissionMode: () => harness.permissionMode,
    run: (prompt, signal) => runMain(harness, skills, prompt, signal, selectedModels.mainError),
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
    pluginCommands: () => [...pluginCommands.keys()].sort(),
    runPluginCommand: async (name, args, signal) => {
      const handler = pluginCommands.get(name);
      if (handler === undefined) throw new Error(`Plugin command /${name} is no longer registered.`);
      signal.throwIfAborted();
      return awaitWithAbort(Promise.resolve(handler(args, { workspace, signal })), signal);
    },
    output: options.output,
  };
  const session = new FlavorSession(services);
  let disposed = false;
  return {
    session, services, approvals,
    get diagnostics() { return diagnostics.map((item) => redactDiagnostic(item, secrets)); },
    async dispose() {
      if (disposed) return;
      disposed = true;
      await cleanupProduction(approvals, pluginHost, harness);
    },
  };
  } catch (primaryError) {
    try { await cleanupProduction(approvals, pluginHost, harnessCreated ? harness : undefined); }
    catch (cleanupError) { attachCleanupError(primaryError, cleanupError); }
    throw primaryError;
  }
}

async function* runMain(
  harness: LocalHarness, skills: SkillRegistry, prompt: string, signal: AbortSignal, setupError?: string,
): AsyncIterable<AgentEvent> {
  let additionalContext: string | undefined;
  try {
    if (setupError !== undefined) {
      yield { type: "error", error: { code: "unknown", message: setupError } };
      return;
    }
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
  providers: Record<string, ProviderRuntimeConfig>,
  registry: ModelRegistry,
  environment: NodeJS.ProcessEnv,
  diagnostics: string[],
): RegisteredProvider[] {
  const configured = { ...providers };
  if (configured.openai === undefined && environment.OPENAI_API_KEY) configured.openai = { type: "openai", apiKey: environment.OPENAI_API_KEY };
  if (configured.anthropic === undefined && environment.ANTHROPIC_API_KEY) configured.anthropic = { type: "anthropic", apiKey: environment.ANTHROPIC_API_KEY };
  const registered: RegisteredProvider[] = [];
  for (const [name, provider] of Object.entries(configured)) {
    try {
      let adapter: ModelAdapter;
      if (provider.type === "openai" && provider.apiKey === undefined) {
        diagnostics.push(`Provider "${name}" requires apiKey or OPENAI_API_KEY.`); continue;
      }
      if (provider.type === "anthropic" && provider.apiKey === undefined) {
        diagnostics.push(`Provider "${name}" requires apiKey or ANTHROPIC_API_KEY.`); continue;
      }
      const adapterOptions = {
        apiKey: provider.apiKey ?? "not-required",
        ...(provider.baseURL === undefined ? {} : { baseURL: provider.baseURL }),
      };
      if (provider.type === "anthropic") adapter = new AnthropicModelAdapter(adapterOptions);
      else if (provider.type === "openai" || provider.type === "openai-compatible") adapter = new OpenAIModelAdapter(adapterOptions);
      else { diagnostics.push(`Provider "${name}" has unsupported type "${provider.type}".`); continue; }
      registry.register(name, adapter);
      registered.push({ name, ...provider });
    } catch (error) { diagnostics.push(`Provider "${name}" could not start: ${message(error)}`); }
  }
  return registered;
}

interface ProviderRuntimeConfig {
  type: string;
  apiKey?: string | undefined;
  baseURL?: string | undefined;
  defaultModel?: string | undefined;
  cheapModel?: string | undefined;
}
interface RegisteredProvider extends ProviderRuntimeConfig { name: string }

function selectModels(
  config: { agents?: { main?: { model: string } | undefined; subagent?: { model: string } | undefined } | undefined; providers: Record<string, ProviderRuntimeConfig> },
  registered: readonly RegisteredProvider[], diagnostics: string[],
): { main: string; child: string; mainError?: string; childError?: string } {
  const configuredMain = config.agents?.main?.model;
  const provider = configuredMain === undefined
    ? registered[0]
    : registered.find((item) => item.name === safeProvider(configuredMain));
  if (configuredMain === undefined && provider === undefined) {
    const error = "No usable model provider is configured. Configure providers and agents in .flavor/flavor.json or set OPENAI_API_KEY/ANTHROPIC_API_KEY.";
    diagnostics.push(error);
    return { main: "openai:gpt-5", child: "openai:gpt-5-mini", mainError: error, childError: error };
  }
  const defaultName = provider?.defaultModel ?? providerDefault(provider?.type);
  if (configuredMain === undefined && defaultName === undefined) {
    const error = `Provider "${provider!.name}" requires defaultModel in .flavor/flavor.json.`;
    diagnostics.push(error);
    return { main: `${provider!.name}:configure-default-model`, child: `${provider!.name}:configure-cheap-model`, mainError: error, childError: error };
  }
  const main = configuredMain ?? `${provider!.name}:${defaultName!}`;
  const childProviderName = safeProvider(main);
  const childProvider = registered.find((item) => item.name === childProviderName)
    ?? (config.providers[childProviderName] === undefined ? undefined : { name: childProviderName, ...config.providers[childProviderName] });
  const explicitChild = config.agents?.subagent?.model;
  const cheapName = childProvider?.cheapModel ?? providerCheapDefault(childProvider?.type);
  if (explicitChild === undefined && cheapName === undefined) {
    const error = `Provider "${childProviderName}" requires cheapModel for subagents in .flavor/flavor.json.`;
    diagnostics.push(error);
    return { main, child: `${childProviderName}:configure-cheap-model`, childError: error };
  }
  const child = explicitChild ?? `${childProviderName}:${cheapName!}`;
  if (child === main) {
    const error = "The subagent model must be cheaper than and different from the main model.";
    diagnostics.push(error);
    return { main, child, childError: error };
  }
  return { main, child };
}

function providerDefault(type: string | undefined): string | undefined {
  if (type === "openai") return "gpt-5";
  if (type === "anthropic") return "claude-opus-4-5";
  return undefined;
}
function providerCheapDefault(type: string | undefined): string | undefined {
  if (type === "openai") return "gpt-5-mini";
  if (type === "anthropic") return "claude-sonnet-4-5";
  return undefined;
}
function safeProvider(modelId: string): string {
  try { return parseModelId(modelId).provider; } catch { return modelId.split(":", 1)[0] ?? modelId; }
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
function awaitWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolvePromise, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => { signal.removeEventListener("abort", onAbort); resolvePromise(value); },
      (error: unknown) => { signal.removeEventListener("abort", onAbort); reject(error); },
    );
  });
}

async function cleanupProduction(
  approvals: ApprovalBridge, pluginHost: PluginHost, harness: LocalHarness | undefined,
): Promise<void> {
  let primary: unknown;
  try { approvals.resolve(false); }
  catch (error) { primary = error; }
  try { await pluginHost.unloadAll(); }
  catch (error) {
    if (primary === undefined) primary = error;
    else attachCleanupError(primary, error);
  }
  finally {
    try { harness?.dispose(); }
    catch (error) {
      if (primary === undefined) primary = error;
      else attachCleanupError(primary, error);
    }
  }
  if (primary !== undefined) throw primary;
}

function attachCleanupError(primary: unknown, cleanup: unknown): void {
  if ((typeof primary !== "object" && typeof primary !== "function") || primary === null || !Object.isExtensible(primary)) return;
  try { Object.defineProperty(primary, "cleanupError", { value: cleanup, configurable: true }); }
  catch { /* Preserve the primary error even when diagnostics cannot be attached. */ }
}
