import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { SubagentResultSchema, SubagentScheduler, type SubagentResult } from "./agent/subagents.js";
import { TaskGraphSchema, TaskPlanner, type TaskGraph, type TaskNode } from "./agent/planner.js";
import { createTaskPlanTools } from "./agent/task-tools.js";
import { updatePlanTask, type TaskPlan } from "./agent/task-plan.js";
import type { AgentEvent, TaskSnapshot } from "./agent/types.js";
import { loadConfig } from "./config/load.js";
import { ContextManager, type ContextSnapshot } from "./context/manager.js";
import { LocalHarness } from "./harness/local.js";
import { HookBus } from "./hooks/bus.js";
import { HOOK_EVENT_NAMES, type HookEventName } from "./hooks/types.js";
import { initializeFlavor } from "./init/project.js";
import { AnthropicModelAdapter } from "./models/anthropic.js";
import { OpenAIModelAdapter } from "./models/openai.js";
import { ModelRegistry, parseModelId } from "./models/registry.js";
import type { ModelAdapter } from "./models/types.js";
import type { PermissionRequest } from "./permissions/engine.js";
import type { ApprovalDecision } from "./tools/runtime.js";
import { PluginHost } from "./plugins/host.js";
import type { PluginCommandHandler } from "./plugins/types.js";
import { SkillRegistry } from "./skills/registry.js";
import { createSkillResourceTool } from "./skills/tool.js";
import { SessionStore, type SessionDocument } from "./session/store.js";
import { createApplyPatchTool, createEditTool, createReadTool, createWriteTool } from "./tools/files.js";
import { createGlobTool, createGrepTool } from "./tools/search.js";
import { createShellTool } from "./tools/shell.js";
import { createAskUserQuestionTool, QuestionBridge, type AskUserQuestionHandler } from "./tools/ask-user-question.js";
import { createTaskOutputTool } from "./tools/task-output.js";
import { createTodoWriteTool } from "./tools/todo-write.js";
import type { ToolDefinition } from "./tools/types.js";
import { FlavorSession, type SessionOutput, type SessionServices } from "./ui/session.js";
import { MVP_COMMANDS } from "./ui/commands.js";
import { resolveLanguage, languageInstruction } from "./utils/intl.js";
import { awaitWithSignal } from "./utils/async.js";
import { message } from "./utils/error.js";
import { redactSecrets } from "./utils/redact.js";
import { AuditLogger } from "./utils/log.js";

export interface ProductionRuntimeOptions {
  workspace?: string;
  home?: string;
  environment?: NodeJS.ProcessEnv;
  output(event: SessionOutput): void;
  onApprovalChange?(): void;
  /** Non-interactive callers must deny requests instead of waiting for input. */
  approvalPolicy?: "prompt" | "deny";
  /** Resume a named session, or the latest session when true. Never resumed implicitly. */
  resumeSession?: string | true;
}

export interface ProductionRuntime {
  session: FlavorSession;
  services: SessionServices;
  approvals: ApprovalBridge;
  diagnostics: readonly string[];
  sessionId: string;
  dispose(): Promise<void>;
}

export class ApprovalBridge {
  #pending: (PermissionRequest & { reason?: string }) | undefined;
  #settle: ((decision: ApprovalDecision) => void) | undefined;
  #removeAbort: (() => void) | undefined;
  readonly #onChange: (() => void) | undefined;

  constructor(onChange?: () => void) { this.#onChange = onChange; }
  get pending(): (PermissionRequest & { reason?: string }) | undefined { return this.#pending; }

  request(request: PermissionRequest & { reason?: string }, signal: AbortSignal = new AbortController().signal): Promise<ApprovalDecision> {
    if (this.#settle !== undefined) return Promise.resolve("deny");
    if (signal.aborted) return Promise.resolve("deny");
    this.#pending = request;
    this.#onChange?.();
    return new Promise<ApprovalDecision>((resolvePromise) => {
      this.#settle = resolvePromise;
      const onAbort = () => this.resolve("deny");
      signal.addEventListener("abort", onAbort, { once: true });
      this.#removeAbort = () => signal.removeEventListener("abort", onAbort);
    });
  }

  resolve(decision: ApprovalDecision): void {
    const settle = this.#settle;
    const changed = settle !== undefined || this.#pending !== undefined;
    this.#removeAbort?.();
    this.#removeAbort = undefined;
    this.#settle = undefined;
    this.#pending = undefined;
    settle?.(decision);
    if (changed) this.#onChange?.();
  }
}

export async function createProductionRuntime(options: ProductionRuntimeOptions): Promise<ProductionRuntime> {
  const workspace = resolve(options.workspace ?? process.cwd());
  const home = resolve(options.home ?? homedir());
  const environment = options.environment ?? process.env;
  const loaded = await loadConfig({ cwd: workspace, home, environment });
  const config = loaded.config;
  const sessionStore = new SessionStore({ workspace });
  const auditLogger = new AuditLogger(workspace);
  const recovered = options.resumeSession === undefined
    ? undefined
    : await sessionStore.load(options.resumeSession === true ? undefined : options.resumeSession);
  const secrets = [
    ...Object.values(config.providers).map((provider) => provider.apiKey),
    environment.OPENAI_API_KEY, environment.ANTHROPIC_API_KEY,
  ].filter((value): value is string => typeof value === "string" && value.length > 0);
  const hooks = new HookBus();
  const registry = new ModelRegistry();
  const diagnostics: string[] = [];
  const approvals = new ApprovalBridge(options.onApprovalChange);
  const questions = new QuestionBridge(options.onApprovalChange);
  const askUserQuestionHandler: AskUserQuestionHandler = async (qs, signal) => {
    if (options.approvalPolicy === "deny") throw new Error("AskUserQuestion is not available in non-interactive mode");
    return questions.ask(qs, signal);
  };
  const tools: ToolDefinition<unknown>[] = [
    createReadTool(workspace), createWriteTool(workspace), createEditTool(workspace), createApplyPatchTool(workspace),
    createGlobTool(workspace), createGrepTool(workspace), createShellTool(workspace),
    createAskUserQuestionTool(askUserQuestionHandler),
    createTaskOutputTool(),
    createTodoWriteTool(),
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
  const mainModel = recovered?.models.main ?? selectedModels.main;
  const childModel = recovered?.models.subagent ?? selectedModels.child;
  let taskPlan: TaskPlan | undefined = recovered?.tasks.plan;
  let taskGraph: TaskGraph | undefined = recovered?.tasks.graph;
  let taskStates: Record<string, "pending" | "running" | "completed" | "failed" | "blocked"> = { ...(recovered?.tasks.states ?? {}) };
  let taskResults: Record<string, SubagentResult> = { ...(recovered?.tasks.results ?? {}) };
  const sessionId = recovered?.sessionId ?? `session-${new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 17)}-${randomUUID().slice(0, 8)}`;
  const createdAt = recovered?.createdAt ?? new Date().toISOString();
  let persistTail: Promise<void> = Promise.resolve();
  const sessionDocument = (): SessionDocument => ({
    version: 1, sessionId, createdAt, updatedAt: new Date().toISOString(), workspace: { path: workspace },
    conversation: storedConversation(harness.main.context.snapshot()),
    tasks: {
      ...(taskPlan === undefined ? {} : { plan: taskPlan }),
      ...(taskGraph === undefined ? {} : { graph: taskGraph }),
      states: { ...taskStates },
      results: { ...taskResults },
    },
    models: { main: harness.mainModelId, subagent: harness.subagentModelId }, permissionMode: harness.permissionMode,
  });
  let persistFailed = false;
  const persist = (): Promise<void> => {
    persistTail = persistTail.catch(() => undefined).then(
      () => sessionStore.save(sessionDocument()),
    ).catch((err) => {
      if (!persistFailed) {
        persistFailed = true;
        try { options.output({ type: "notice", message: `Session save failed: ${message(err)}. Your conversation may not be preserved.` }); }
        catch { /* Output may be unavailable during shutdown */ }
      }
    });
    return persistTail;
  };

  const taskSnapshot = (): TaskSnapshot => {
    const foregroundTaskId = taskPlan?.tasks.find((task) => task.status === "in_progress")?.id;
    return {
      ...(taskPlan === undefined ? {} : { plan: taskPlan }),
      subagents: {
        ...(taskGraph === undefined ? {} : { graph: taskGraph }),
        states: { ...taskStates },
      },
      ...(foregroundTaskId === undefined ? {} : { foregroundTaskId }),
    };
  };
  const serializedTaskState = (): string | undefined => {
    if (taskPlan === undefined && taskGraph === undefined) return undefined;
    return JSON.stringify(taskSnapshot());
  };
  const publishTaskState = async (): Promise<void> => {
    harness.main.context.updateTaskState(serializedTaskState());
    await persist();
    options.output({ type: "tasks", snapshot: taskSnapshot() });
  };

  for (const tool of createTaskPlanTools({
    getPlan: () => taskPlan,
    commit: async (next) => {
      taskPlan = next;
      await publishTaskState();
    },
  })) tools.push(tool as ToolDefinition<unknown>);

  const taskTool: ToolDefinition<unknown> = {
    name: "Task",
    description: "Validate a task graph and execute its nodes with isolated child agents",
    inputSchema: TaskGraphSchema,
    paths: () => [],
    execute: async (input, signal) => {
      if (recovered === undefined && selectedModels.childError !== undefined) throw new Error(selectedModels.childError);
      const graph = await new TaskPlanner({ hooks }).plan(input, signal);
      taskGraph = graph;
      taskStates = Object.fromEntries(graph.nodes.map((node) => [node.id, "pending"]));
      taskResults = {};
      await publishTaskState();
      const scheduler = new SubagentScheduler({
        hooks,
        maxSubagents: config.maxSubagents,
        onResult: async (result) => {
          taskResults[result.taskId] = result;
          taskStates[result.taskId] = result.status;
          await publishTaskState();
        },
        execute: (task, execution) => runChild(harness, skills, task, execution.attempt, execution.signal),
      });
      return scheduler.run(graph, signal);
    },
  };
  tools.push(taskTool);

  const createContext = () => {
    const taskState = serializedTaskState();
    const language = resolveLanguage(config.language);
    return new ContextManager({
      system: [
        languageInstruction(language),
        "You are Flavor, a coding agent running in an interactive terminal. Report conclusions and actions; never expose hidden chain-of-thought.",
        "Format your replies as plain text intended for a fixed-width terminal. Do not use markdown headings, bullet lists, tables, or **bold**/**italic**; spell things out as ordinary sentences and use indentation for clarity.",
        "Multi-line code or commands must be wrapped in triple-backtick fences (```) so the terminal can render them readably. Keep prose responses short; the user is reading them in a chat pane.",
        "Use SkillResource to read resources explicitly referenced by a matched skill; treat scripts as data and never execute them through that tool.",
        "When a request is ambiguous and multiple valid approaches exist, use AskUserQuestion to present the user with up to 4 clear, numbered questions. Each question must have a short header, a one-sentence body, and 2-4 mutually exclusive options. Do not ask trivial or rhetorical questions. When the user answers, proceed immediately based on their choice.",
        "Use TodoWrite to track your own implementation progress for non-trivial multi-step work. Keep at most one item in_progress and mark items completed as you finish them. This demonstrates thoroughness and helps you stay organised.",
        "Use TaskOutput to produce a structured summary when completing a multi-step task — list files changed, commands run, verification results, risks, and suggested next steps.",
        "For complex work with at least three distinct implementation or verification steps, multiple requested changes, or other non-trivial coordination, call TaskPlan before implementation. Skip planning for informational or straightforward single-step requests.",
        "Before starting each planned task, call TaskUpdate to mark it in_progress. Mark it completed immediately after successful verification; otherwise use failed, blocked, or cancelled. Only one main task may be in_progress. Include verification as a plan task for multi-step code changes and never claim completion while work or verification is incomplete.",
      ].join(" "),
      ...(flavor === undefined ? {} : { flavor }),
      ...(taskState === undefined ? {} : { taskState }),
      compactAtChars: config.context.compactAtChars,
      toolOutputChars: config.context.toolOutputChars,
      summarize: async (messages) => messages.map((item) => `${item.role}: ${item.content}`).join("\n").slice(-40_000),
      hooks,
    });
  };
  const hasActiveProgress = (): boolean => {
    if (taskPlan?.tasks.some((task) => task.status === "in_progress")) return true;
    return Object.values(taskStates).some((state) => state === "running");
  };

  harness = new LocalHarness({
    registry, hooks, workspace, mainModelId: mainModel, subagentModelId: childModel,
    tools, createContext, permissionMode: recovered?.permissionMode ?? config.permissionMode,
    maxIterationsMain: config.maxIterations.main,
    maxIterationsSubagent: config.maxIterations.subagent,
    hasActiveProgress,
    approve: options.approvalPolicy === "deny" ? () => "deny" as ApprovalDecision : (request, signal) => approvals.request(request, signal),
  });
  harnessCreated = true;
  if (recovered !== undefined) harness.main.context.restore({
    ...(recovered.conversation.summary === undefined ? {} : { summary: recovered.conversation.summary }),
    messages: recovered.conversation.messages.map((message) => ({
      role: message.role, content: message.content,
      ...(message.toolCallId === undefined ? {} : { toolCallId: message.toolCallId }),
      ...(message.toolCalls === undefined ? {} : { toolCalls: message.toolCalls }),
    })),
  });

  hooks.on("SubagentStart", async (event) => {
    const id = String(event.payload.taskId); taskStates[id] = "running"; await publishTaskState(); return { decision: "allow" };
  });
  hooks.on("SubagentStop", async (event) => {
    const id = String(event.payload.taskId);
    const status = event.payload.status;
    if (status === "completed" || status === "failed" || status === "blocked") taskStates[id] = status;
    await publishTaskState(); return { decision: "allow" };
  });
  hooks.on("SessionStart", () => {
    if (taskPlan !== undefined || taskGraph !== undefined) options.output({ type: "tasks", snapshot: taskSnapshot() });
    return { decision: "allow" };
  });
  hooks.on("SessionEnd", async () => { await persist(); return { decision: "allow" }; });
  hooks.on("PostToolUseFailure", (event) => {
    const { tool, input, agent, error } = event.payload as Record<string, unknown>;
    void auditLogger.append({
      timestamp: new Date().toISOString(),
      sessionId,
      event: "PostToolUseFailure",
      tool: typeof tool === "string" ? tool : undefined,
      agent: typeof agent === "string" ? agent : undefined,
      errorCode: typeof error === "object" && error !== null ? (error as Record<string, unknown>).code as string | undefined : undefined,
      errorMessage: typeof error === "object" && error !== null ? (error as Record<string, unknown>).message as string | undefined : undefined,
      input,
    });
    return { decision: "allow" };
  });

  const services: SessionServices = {
    hooks, workspace,
    mainModel: () => harness.mainModelId,
    subagentModel: () => harness.subagentModelId,
    permissionMode: () => harness.permissionMode,
    run: (prompt, signal) => persistAfter(runMain(harness, skills, prompt, signal, selectedModels.mainError), persist),
    runSkill: (skill, prompt, signal) => persistAfter(
      runExplicitSkill(harness, skills, skill, prompt, signal, selectedModels.mainError), persist,
    ),
    setModel: async (role, id) => { harness.setModel(role, id); await persist(); },
    setPermissionMode: async (mode) => { harness.setPermissionMode(mode); await persist(); },
    compact: async (signal) => { const changed = await harness.main.context.compact(signal); if (changed) await persist(); return changed; },
    initialize: () => initializeFlavor(workspace),
    config: () => ({
      ...config, sources: loaded.sources,
      diagnostics: [...diagnostics, ...pluginHost.diagnostics.map((item) => `${item.plugin}: ${item.message}`),
        ...skills.diagnostics.map((item) => `${item.path}: ${item.message}`)].map((item) => redactSecrets(item, secrets)),
    }),
    skills: () => skills.discover(),
    plugins: () => pluginHost.loadedPlugins,
    hooksStatus: () => HOOK_EVENT_NAMES.map((name) => ({ name, pluginHandlers: pluginHooks.filter((item) => item === name).length })),
    tasks: () => ({ plan: taskPlan, graph: taskGraph, states: taskStates, results: taskResults }),
    audit: async (toolFilter?: string) => {
      try {
        const raw = await readFile(auditLogger.path, "utf8");
        const lines = raw.trim().split("\n").filter((line) => line.length > 0);
        const entries = lines.map((line) => {
          try { return JSON.parse(line) as Record<string, unknown>; }
          catch { return undefined; }
        }).filter((entry): entry is Record<string, unknown> => entry !== undefined);
        const filtered = toolFilter === undefined
          ? entries
          : entries.filter((entry) => entry.tool === toolFilter);
        if (filtered.length === 0) {
          return toolFilter === undefined
            ? "No tool failures recorded."
            : `No failures recorded for tool "${toolFilter}".`;
        }
        const header = toolFilter === undefined
          ? `Audit log (${filtered.length} entries):`
          : `Audit log for ${toolFilter} (${filtered.length} entries):`;
        const body = filtered.map((entry) => {
          const time = (entry.timestamp as string ?? "").replace("T", " ").slice(0, 19);
          return `  ${time}  ${entry.sessionId}  ${entry.tool ?? "-"}  ${entry.errorCode ?? "-"}: ${entry.errorMessage ?? "-"}`;
        }).join("\n");
        // Summarise by tool
        const byTool = new Map<string, number>();
        for (const entry of filtered) {
          const tool = (entry.tool as string) ?? "unknown";
          byTool.set(tool, (byTool.get(tool) ?? 0) + 1);
        }
        const summary = [...byTool.entries()]
          .sort((a, b) => b[1] - a[1])
          .map(([tool, count]) => `  ${tool}: ${count}`)
          .join("\n");
        return `${header}\n\n${body}\n\nBy tool:\n${summary}`;
      } catch (error) {
        if (typeof error === "object" && error !== null && "code" in error && (error as Record<string, unknown>).code === "ENOENT") {
          return "No audit log exists yet. Tool failures will be recorded here as they occur.";
        }
        return `Failed to read audit log: ${message(error)}`;
      }
    },
    cancelActiveTask: async () => {
      const active = taskPlan?.tasks.find((task) => task.status === "in_progress");
      if (taskPlan === undefined || active === undefined) return;
      taskPlan = updatePlanTask(taskPlan, {
        taskId: active.id,
        status: "cancelled",
        result: "Cancelled by user",
      });
      await publishTaskState();
    },
    pluginCommands: () => [...pluginCommands.keys()].sort(),
    runPluginCommand: async (name, args, signal) => {
      const handler = pluginCommands.get(name);
      if (handler === undefined) throw new Error(`Plugin command /${name} is no longer registered.`);
      signal.throwIfAborted();
      return awaitWithSignal(Promise.resolve(handler(args, { workspace, signal })), signal);
    },
    output: options.output,
    questions,
  };
  const session = new FlavorSession(services);
  let disposed = false;
  return {
    session, services, approvals, sessionId,
    get diagnostics() { return diagnostics.map((item) => redactSecrets(item, secrets)); },
    async dispose() {
      if (disposed) return;
      disposed = true;
      await persist();
      await persistTail;
      auditLogger.close();
      await cleanupProduction(approvals, questions, pluginHost, harness);
    },
  };
  } catch (primaryError) {
    try { await cleanupProduction(approvals, questions, pluginHost, harnessCreated ? harness : undefined); }
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

async function* runExplicitSkill(
  harness: LocalHarness,
  skills: SkillRegistry,
  skillName: string,
  prompt: string,
  signal: AbortSignal,
  setupError?: string,
): AsyncIterable<AgentEvent> {
  try {
    if (setupError !== undefined) {
      yield { type: "error", error: { code: "unknown", message: setupError } };
      return;
    }
    const skill = (await skills.discover()).find(({ name }) => name === skillName);
    if (skill === undefined) {
      yield { type: "error", error: { code: "unknown", message: `Unknown skill: ${skillName}` } };
      return;
    }
    const userPrompt = prompt || `Apply the ${skillName} skill.`;
    const additionalContext = `Matched skill: ${skill.name}\n${await skills.loadBody(skill)}`;
    yield* harness.main.loop.run({ prompt: userPrompt, signal, additionalContext });
  } catch (error) {
    yield { type: "error", error: { code: "unknown", message: message(error) } };
  }
}

async function* persistAfter<T>(source: AsyncIterable<T>, persist: () => Promise<void>): AsyncIterable<T> {
  try { for await (const item of source) yield item; }
  finally { await persist(); }
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
function storedConversation(snapshot: ContextSnapshot): SessionDocument["conversation"] {
  return {
    ...(snapshot.summary === undefined ? {} : { summary: snapshot.summary }),
    messages: snapshot.messages.filter((message) => message.role !== "system").map((message) => ({
      role: message.role as "user" | "assistant" | "tool", content: message.content,
      ...(message.toolCallId === undefined ? {} : { toolCallId: message.toolCallId }),
      ...(message.toolCalls === undefined ? {} : { toolCalls: message.toolCalls }),
    })),
  };
}

async function cleanupProduction(
  approvals: ApprovalBridge, questions: QuestionBridge, pluginHost: PluginHost, harness: LocalHarness | undefined,
): Promise<void> {
  let primary: unknown;
  try { approvals.resolve("deny"); }
  catch (error) { primary = error; }
  try { questions.dispose(); }
  catch (error) {
    if (primary === undefined) primary = error;
    else attachCleanupError(primary, error);
  }
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
