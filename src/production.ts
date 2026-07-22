import { readFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { homedir, release as osRelease, version as osVersion } from "node:os";
import { join, relative, resolve, sep } from "node:path";

import {
  parseFinalSubagentMessage,
  subagentResultFromTaskOutput,
  SubagentResultSchema,
  SubagentScheduler,
  type SubagentResult,
} from "./agent/subagents.js";
import { TaskGraphSchema, TaskPlanner, type TaskGraph, type TaskNode } from "./agent/planner.js";
import { createTaskPlanTools } from "./agent/task-tools.js";
import { updatePlanTask, type TaskPlan } from "./agent/task-plan.js";
import type { AgentEvent, TaskSnapshot } from "./agent/types.js";
import { loadConfig, setProjectMcpServerDisabled } from "./config/load.js";
import { ContextManager, type CompactProgressCallback, type ContextSnapshot } from "./context/manager.js";
import { summarizeWithModel } from "./context/summarizer.js";
import { LocalHarness } from "./harness/local.js";
import { HookBus } from "./hooks/bus.js";
import { HOOK_EVENT_NAMES, type HookEventName } from "./hooks/types.js";
import { createIncidentReporter } from "./incidents/reporter.js";
import { initializeFlavor } from "./init/project.js";
import { LoopOrchestrator, type LoopRuntimeEvent } from "./loop/orchestrator.js";
import { GoalOrchestrator } from "./goal/orchestrator.js";
import { prepareLoopWorkspace } from "./loop/isolation.js";
import { LoopStore } from "./loop/store.js";
import type { LoopStatus } from "./loop/types.js";
import { inferVerificationPlan, runVerificationPlan } from "./loop/verifier.js";
import { AnthropicModelAdapter } from "./models/anthropic.js";
import { OpenAIModelAdapter } from "./models/openai.js";
import { ModelRegistry, parseModelId } from "./models/registry.js";
import type { ModelAdapter, ModelMessage } from "./models/types.js";
import { connectMcpServers, McpManager, type McpClientFactory, type McpServerSummary } from "./mcp/client.js";
import { connectSdkMcpClient } from "./mcp/sdk.js";
import { OAuthCallbackAuthProvider } from "./auth/oauth.js";
import { createFileTokenStore } from "./auth/store.js";
import type { PermissionRequest } from "./permissions/engine.js";
import { buildSubagentDirective, buildSystemPrompt, type PromptEnvironment } from "./prompts/system.js";
import type { ApprovalDecision } from "./tools/runtime.js";
import { PluginHost } from "./plugins/host.js";
import type { PluginCommandHandler } from "./plugins/types.js";
import { SkillRegistry } from "./skills/registry.js";
import { createSkillResourceTool } from "./skills/tool.js";
import { SESSION_VERSION, SessionStore, type SessionDocument } from "./session/store.js";
import { createApplyPatchTool, createEditTool, createReadTool, createWriteTool } from "./tools/files.js";
import { createGlobTool, createGrepTool } from "./tools/search.js";
import { createShellTool } from "./tools/shell.js";
import { createLspTools } from "./tools/lsp.js";
import { createAskUserQuestionTool, QuestionBridge, type AskUserQuestionHandler } from "./tools/ask-user-question.js";
import { createTaskOutputTool } from "./tools/task-output.js";
import { createTodoWriteTool } from "./tools/todo-write.js";
import type { ToolDefinition } from "./tools/types.js";
import { FlavorSession, type SessionOutput, type SessionServices } from "./ui/session.js";
import { createTranscriptState, restoreTranscriptState, transcriptReducer, type TranscriptState } from "./ui/transcript.js";
import { MVP_COMMANDS } from "./ui/commands.js";
import { resolveLanguage, languageInstruction } from "./utils/intl.js";
import { awaitWithSignal } from "./utils/async.js";
import { message } from "./utils/error.js";
import { execFileNoThrow } from "./utils/execFileNoThrow.js";
import { redactSecrets } from "./utils/redact.js";
import { HallucinationGuard } from "./hallucination/guard.js";
import { AuditLogger } from "./utils/log.js";
import { MemoryCoordinator } from "./memory/coordinator.js";
import { MemoryStore, formatMemoryContext, renderMemoryDocument } from "./memory/store.js";

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
  /** Test and embedding seam for creating configured MCP clients. */
  mcpClientFactory?: McpClientFactory;
}

export interface ProductionRuntime {
  session: FlavorSession;
  services: SessionServices;
  approvals: ApprovalBridge;
  diagnostics: readonly string[];
  sessionId: string;
  restoredTranscript: TranscriptState;
  dispose(): Promise<void>;
}

export interface PromptEnvironmentInput {
  now?: Date;
  platform?: string;
  osVersion?: string;
  shell?: string;
  isGitRepository?: boolean | "unknown";
}

export function createPromptEnvironment(input: PromptEnvironmentInput = {}): PromptEnvironment {
  const now = input.now ?? new Date();
  return {
    date: Number.isNaN(now.getTime()) ? "unknown" : now.toISOString().slice(0, 10),
    platform: promptEnvironmentValue(input.platform ?? process.platform),
    osVersion: promptEnvironmentValue(input.osVersion ?? `${osVersion()} ${osRelease()}`),
    shell: promptEnvironmentValue(input.shell ?? process.env.ComSpec ?? process.env.SHELL),
    isGitRepository: input.isGitRepository ?? "unknown",
  };
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
  const sessionStore = new SessionStore({ workspace, maxSessions: config.maxSessions });
  const memoryStore = config.memory.enabled ? new MemoryStore({
    workspace,
    maxEntries: config.memory.maxEntries,
    maxEntryChars: config.memory.maxEntryChars,
  }) : undefined;
  const auditLogger = new AuditLogger(workspace);
  const recovered = options.resumeSession === undefined
    ? undefined
    : await sessionStore.load(options.resumeSession === true ? undefined : options.resumeSession);
  let timelineState = recovered === undefined
    ? createTranscriptState()
    : restoreTranscriptState(recovered.timeline.state);
  const restoredTranscript = restoreTranscriptState(timelineState);
  const emitOutput = (event: SessionOutput): void => {
    timelineState = transcriptReducer(timelineState, { type: "session", event });
    options.output(event);
  };
  const secrets = [
    ...Object.values(config.providers).map((provider) => provider.apiKey),
    ...Object.values(config.mcpServers).flatMap((server) =>
      Object.values("command" in server ? server.env : server.headers)),
    environment.OPENAI_API_KEY, environment.ANTHROPIC_API_KEY,
  ].filter((value): value is string => typeof value === "string" && value.length > 0);
  const hooks = new HookBus();

  // Wire the incident reporter — reports tool failures to langgraph-claw for
  // automated root-cause analysis. Enabled via incidents.enabled in flavor.json
  // or FLAVOR_INCIDENT_ENABLED=true env var.
  hooks.on(
    "PostToolUseFailure",
    createIncidentReporter({
      workspace,
      enabled: config.incidents.enabled || environment.FLAVOR_INCIDENT_ENABLED === "true",
      ...(config.incidents.webhookUrl !== undefined
        ? { webhookUrl: config.incidents.webhookUrl }
        : environment.FLAVOR_INCIDENT_WEBHOOK_URL !== undefined
          ? { webhookUrl: environment.FLAVOR_INCIDENT_WEBHOOK_URL }
          : {}),
    }),
    { failurePolicy: "allow" },
  );

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
    ...createLspTools(workspace, {
      onStatus: (message) => emitOutput({ type: "notice", message }),
    }),
    ...(options.approvalPolicy === "deny" ? [] : [createAskUserQuestionTool(askUserQuestionHandler)]),
    createTaskOutputTool(),
    createTodoWriteTool(),
  ];
  const pluginSkillRoots: string[] = [];
  const pluginHooks: HookEventName[] = [];
  const pluginCommands = new Map<string, PluginCommandHandler>();
  const mcpTools: ToolDefinition<unknown>[] = [];
  let mcpManager: McpManager | undefined;

  const registeredProviders = await registerConfiguredAdapters(config.providers, registry, environment, diagnostics, home);

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
  mcpManager = await connectMcpServers({
    servers: config.mcpServers,
    workspace,
    clientFactory: options.mcpClientFactory ?? connectSdkMcpClient,
  });
  diagnostics.push(...mcpManager.diagnostics);
  const syncMcpTools = (): void => {
    for (const tool of mcpTools) remove(tools, tool);
    mcpTools.length = 0;
    for (const tool of mcpManager!.tools) {
      if (tools.some((candidate) => candidate.name === tool.name)) {
        const diagnostic = `MCP tool "${tool.name}" conflicts with an existing tool and was skipped`;
        if (!diagnostics.includes(diagnostic)) diagnostics.push(diagnostic);
        continue;
      }
      tools.push(tool);
      mcpTools.push(tool);
    }
    if (harnessCreated) harness.replaceMainTools(tools);
  };
  syncMcpTools();
  const skills = new SkillRegistry({
    globalRoots: [join(home, ".flavor-code", "skills")],
    projectRoots: [join(workspace, ".flavor", "skills"), ...pluginSkillRoots],
    authorizeResource: async () => true,
    disabledNames: config.skills.disabled,
  });
  await skills.discover();
  tools.push(createSkillResourceTool(skills));
  const flavor = await optionalText(join(workspace, "FLAVOR.md"));
  let memoryContext: string | undefined;
  if (memoryStore !== undefined) {
    try {
      memoryContext = formatMemoryContext(await memoryStore.list(), config.memory.maxPromptChars);
    } catch (error) {
      diagnostics.push(`Long-term memory load failed: ${message(error)}`);
    }
  }
  const selectedModels = selectModels(config, registeredProviders, diagnostics);
  const mainModel = recovered?.models.main ?? selectedModels.main;
  const childModel = recovered?.models.subagent ?? selectedModels.child;
  let taskPlan: TaskPlan | undefined = recovered?.tasks.plan;
  let taskGraph: TaskGraph | undefined = recovered?.tasks.graph;
  let taskStates: Record<string, "pending" | "running" | "completed" | "failed" | "blocked" | "cancelled"> = { ...(recovered?.tasks.states ?? {}) };
  let taskResults: Record<string, SubagentResult> = { ...(recovered?.tasks.results ?? {}) };
  const subagentStartedAt: Record<string, number> = {};
  const subagentElapsedMs: Record<string, number> = {};
  let sessionId = recovered?.sessionId ?? `session-${new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 17)}-${randomUUID().slice(0, 8)}`;
  let createdAt = recovered?.createdAt ?? new Date().toISOString();
  let persistTail: Promise<void> = Promise.resolve();
  const sessionDocument = (): SessionDocument => ({
    version: SESSION_VERSION, sessionId, createdAt, updatedAt: new Date().toISOString(), workspace: { path: workspace },
    conversation: storedConversation(harness.main.context.snapshot()),
    tasks: {
      ...(taskPlan === undefined ? {} : { plan: taskPlan }),
      ...(taskGraph === undefined ? {} : { graph: taskGraph }),
      states: { ...taskStates },
      results: { ...taskResults },
    },
    models: { main: harness.mainModelId, subagent: harness.subagentModelId }, permissionMode: harness.permissionMode,
    timeline: { version: 1, state: timelineState },
  });
  let persistFailed = false;
  const persist = (): Promise<void> => {
    persistTail = persistTail.catch(() => undefined).then(
      () => sessionStore.save(sessionDocument()),
    ).catch((err) => {
      if (!persistFailed) {
        persistFailed = true;
        try { emitOutput({ type: "notice", message: `Session save failed: ${message(err)}. Your conversation may not be preserved.` }); }
        catch { /* Output may be unavailable during shutdown */ }
      }
    });
    return persistTail;
  };

  const taskSnapshot = (): TaskSnapshot => {
    const foregroundTaskId = taskPlan?.tasks.find((task) => task.status === "in_progress")?.id;
    const startedAt = Object.keys(subagentStartedAt).length > 0
      ? { ...subagentStartedAt } : undefined;
    const elapsedMs = Object.keys(subagentElapsedMs).length > 0
      ? { ...subagentElapsedMs } : undefined;
    return {
      ...(taskPlan === undefined ? {} : { plan: taskPlan }),
      subagents: {
        ...(taskGraph === undefined ? {} : { graph: taskGraph }),
        states: { ...taskStates },
        ...(startedAt === undefined ? {} : { startedAt }),
        ...(elapsedMs === undefined ? {} : { elapsedMs }),
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
    emitOutput({ type: "tasks", snapshot: taskSnapshot() });
  };

  for (const tool of createTaskPlanTools({
    getPlan: () => taskPlan,
    commit: async (next, operation) => {
      taskPlan = next;
      if (operation === "replace") {
        taskGraph = undefined;
        taskStates = {};
        taskResults = {};
        for (const key of Object.keys(subagentStartedAt)) delete subagentStartedAt[key];
        for (const key of Object.keys(subagentElapsedMs)) delete subagentElapsedMs[key];
      }
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
      // Merge new graph nodes into the accumulated task graph so that
      // sub-agent statuses from prior Task calls are preserved instead of
      // being overwritten.
      const priorIds = new Set((taskGraph?.nodes ?? []).map((node) => node.id));
      const mergedNodes = [...(taskGraph?.nodes ?? [])];
      for (const node of graph.nodes) {
        const index = mergedNodes.findIndex((existing) => existing.id === node.id);
        if (index >= 0) mergedNodes[index] = node;
        else mergedNodes.push(node);
      }
      taskGraph = { nodes: mergedNodes };
      for (const node of graph.nodes) {
        taskStates[node.id] = "pending";
      }
      await publishTaskState();
      const subagentParentContext = harness.main.context.fork();
      const scheduler = new SubagentScheduler({
        hooks,
        maxSubagents: config.maxSubagents,
        onResult: async (result) => {
          taskResults[result.taskId] = result;
          taskStates[result.taskId] = result.status;
          await publishTaskState();
        },
        execute: (task, execution) => runChild(
          harness, skills, task, execution.attempt, execution.signal, subagentParentContext,
        ),
      });
      return scheduler.run(graph, signal);
    },
  };
  tools.push(taskTool);

  const promptEnvironment = createPromptEnvironment({
    now: new Date(),
    platform: process.platform,
    osVersion: `${osVersion()} ${osRelease()}`,
    shell: environment.ComSpec ?? environment.SHELL ?? "unknown",
    isGitRepository: await detectGitRepository(workspace),
  });
  const createContext = (
    agent: "main" | "subagent",
    agentTools: readonly ToolDefinition<unknown>[],
    contextModelId: string,
    parentContext?: ContextManager,
  ) => {
    const taskState = serializedTaskState();
    const language = resolveLanguage(config.language);
    const {
      compactAtChars,
      toolOutputChars,
      ...compaction
    } = config.context;
    const summarize = (messages: readonly ModelMessage[], signal: AbortSignal, onProgress?: CompactProgressCallback) => summarizeWithModel({
      registry,
      modelId: () => agent === "main" ? harness.mainModelId : harness.subagentModelId,
      messages,
      signal,
      ...(onProgress === undefined ? {} : { onProgress }),
    });
    const onCompactProgress = (progress: number) => emitOutput({ type: "compact-progress" as const, progress });
    if (agent === "subagent" && parentContext !== undefined) {
      return parentContext.fork({ summarize, onCompactProgress, hooks });
    }
    return new ContextManager({
      system: () => buildSystemPrompt({
        agent,
        languageInstruction: languageInstruction(language),
        workspace,
        model: agent === "main" ? harness.mainModelId : contextModelId,
        permissionMode: agent === "subagent"
          ? (harness.permissionMode === "plan" ? "plan" : "bubble")
          : harness.permissionMode,
        toolNames: new Set(agentTools.map((tool) => tool.name)),
        environment: promptEnvironment,
      }),
      ...(flavor === undefined ? {} : { flavor }),
      ...(memoryContext === undefined ? {} : { memory: memoryContext }),
      ...(taskState === undefined ? {} : { taskState }),
      ...(compactAtChars === undefined ? {} : { compactAtChars }),
      toolOutputChars,
      compaction,
      summarize,
      onCompactProgress,
      hooks,
    });
  };
  const hasActiveProgress = (): boolean => {
    if (taskPlan?.tasks.some((task) => task.status === "in_progress")) return true;
    return Object.values(taskStates).some((state) => state === "running");
  };

  const language = resolveLanguage(config.language);
  const hallucinationGuard = new HallucinationGuard({
    registry,
    cheapModelId: childModel,
    language,
    showWarnings: config.hallucination.showWarnings,
    evaluationTimeoutMs: config.hallucination.evaluationTimeoutMs,
  });
  harness = new LocalHarness({
    registry, hooks, workspace, mainModelId: mainModel, subagentModelId: childModel,
    hallucinationGuard,
    tools, createContext, permissionMode: recovered?.permissionMode ?? config.permissionMode,
    maxIterationsMain: config.maxIterations.main,
    maxIterationsSubagent: config.maxIterations.subagent,
    hasActiveProgress,
    approve: options.approvalPolicy === "deny" ? () => "deny" as ApprovalDecision : (request, signal) => approvals.request(request, signal),
  });
  harnessCreated = true;
  if (recovered !== undefined) harness.main.context.restore({
    ...(recovered.conversation.compact === undefined ? {} : { compact: recovered.conversation.compact }),
    messages: recovered.conversation.messages.map((message) => ({
      role: message.role, content: message.content,
      ...(message.toolCallId === undefined ? {} : { toolCallId: message.toolCallId }),
      ...(message.toolCalls === undefined ? {} : { toolCalls: message.toolCalls }),
    })),
  });

  hooks.on("SubagentStart", async (event) => {
    const id = String(event.payload.taskId); taskStates[id] = "running"; subagentStartedAt[id] = Date.now(); await publishTaskState(); return { decision: "allow" };
  });
  hooks.on("SubagentStop", async (event) => {
    const id = String(event.payload.taskId);
    const status = event.payload.status;
    if (status === "completed" || status === "failed" || status === "blocked" || status === "cancelled") {
      taskStates[id] = status;
      if (subagentStartedAt[id] !== undefined && subagentElapsedMs[id] === undefined) {
        subagentElapsedMs[id] = Math.max(0, Date.now() - subagentStartedAt[id]!);
      }
    }
    await publishTaskState(); return { decision: "allow" };
  });
  hooks.on("SessionStart", () => {
    if (taskPlan !== undefined || taskGraph !== undefined) emitOutput({ type: "tasks", snapshot: taskSnapshot() });
    return { decision: "allow" };
  });
  const memoryCoordinator = memoryStore !== undefined && config.memory.autoExtract
    ? new MemoryCoordinator({
      store: memoryStore,
      minChars: config.memory.autoExtractMinChars,
      maxEntryChars: config.memory.maxEntryChars,
      generate: (prompt, signal) => generateMemoryExtraction(registry, childModel, prompt, signal),
    })
    : undefined;
  if (memoryCoordinator !== undefined) {
    memoryCoordinator.onError = (error) => diagnostics.push(`Long-term memory extraction failed: ${message(error)}`);
  }
  let memoryCursor = harness.main.context.snapshot().messages.length;
  hooks.on("UserPromptSubmit", (event) => {
    timelineState = transcriptReducer(timelineState, { type: "submit", prompt: String(event.payload.prompt) });
    return { decision: "allow" };
  });
  hooks.on("Stop", async (event) => {
    timelineState = transcriptReducer(timelineState, { type: "finish" });
    await persist();
    const snapshot = harness.main.context.snapshot().messages;
    const added = snapshot.slice(memoryCursor);
    memoryCursor = snapshot.length;
    if (event.payload.outcome === "completed") memoryCoordinator?.enqueue(added);
    return { decision: "allow" };
  });
  hooks.on("SessionEnd", async () => {
    await memoryCoordinator?.flush();
    await persist();
    return { decision: "allow" };
  });
  hooks.on("AfterModelCall", (event) => {
    const {
      modelId, agent, providerError, errorCode, errorMessage, attempt, maxAttempts,
      purpose, tool, repairAttempt, repairMaxAttempts,
    } = event.payload as Record<string, unknown>;
    if (providerError === true) {
      void auditLogger.append({
        timestamp: new Date().toISOString(),
        sessionId,
        event: "ModelCallFailure",
        model: typeof modelId === "string" ? modelId : undefined,
        agent: typeof agent === "string" ? agent : undefined,
        errorCode: typeof errorCode === "string" ? errorCode : undefined,
        errorMessage: typeof errorMessage === "string" ? errorMessage : undefined,
        attempt: typeof attempt === "number" ? attempt : undefined,
        maxAttempts: typeof maxAttempts === "number" ? maxAttempts : undefined,
        purpose: typeof purpose === "string" ? purpose : undefined,
        tool: typeof tool === "string" ? tool : undefined,
        repairAttempt: typeof repairAttempt === "number" ? repairAttempt : undefined,
        repairMaxAttempts: typeof repairMaxAttempts === "number" ? repairMaxAttempts : undefined,
      });
    }
    return { decision: "allow" };
  });
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

  const runLoopWorker = async function* (input: {
    workspace: string; prompt: string; signal: AbortSignal;
  }): AsyncIterable<AgentEvent> {
    if (selectedModels.mainError !== undefined) {
      yield { type: "error", error: { code: "unknown", message: selectedModels.mainError } };
      return;
    }
    const loopTools: ToolDefinition<unknown>[] = [
      createReadTool(input.workspace), createWriteTool(input.workspace), createEditTool(input.workspace),
      createApplyPatchTool(input.workspace), createGlobTool(input.workspace), createGrepTool(input.workspace),
      createShellTool(input.workspace),
      ...createLspTools(input.workspace, {
        onStatus: (status) => emitOutput({ type: "notice", message: status }),
      }),
      createTodoWriteTool(),
      ...mcpTools,
    ];
    const loopFlavor = await optionalText(join(input.workspace, "FLAVOR.md"));
    const loopEnvironment = createPromptEnvironment({
      now: new Date(), platform: process.platform, osVersion: `${osVersion()} ${osRelease()}`,
      shell: environment.ComSpec ?? environment.SHELL ?? "unknown",
      isGitRepository: await detectGitRepository(input.workspace),
    });
    let compactionInputTokens = 0;
    let compactionOutputTokens = 0;
    let loopHarness!: LocalHarness;
    const createLoopContext = (
      agent: "main" | "subagent", agentTools: readonly ToolDefinition<unknown>[], contextModelId: string,
    ) => {
      const language = resolveLanguage(config.language);
      const { compactAtChars, toolOutputChars, ...compaction } = config.context;
      return new ContextManager({
        system: () => buildSystemPrompt({
          agent,
          languageInstruction: languageInstruction(language),
          workspace: input.workspace,
          model: agent === "main" ? loopHarness.mainModelId : contextModelId,
          permissionMode: agent === "subagent"
            ? (loopHarness.permissionMode === "plan" ? "plan" : "bubble")
            : loopHarness.permissionMode,
          toolNames: new Set(agentTools.map((tool) => tool.name)),
          environment: loopEnvironment,
        }),
        ...(loopFlavor === undefined ? {} : { flavor: loopFlavor }),
        ...(memoryContext === undefined ? {} : { memory: memoryContext }),
        ...(compactAtChars === undefined ? {} : { compactAtChars }),
        toolOutputChars,
        compaction,
        summarize: (messages, compactSignal, onProgress) => summarizeWithModel({
          registry, modelId: () => loopHarness.mainModelId, messages, signal: compactSignal,
          ...(onProgress === undefined ? {} : { onProgress }),
          onUsage: (usage) => {
            compactionInputTokens += usage.inputTokens;
            compactionOutputTokens += usage.outputTokens;
          },
        }),
        onCompactProgress: (progress) => emitOutput({ type: "compact-progress", progress }),
        hooks,
      });
    };
    loopHarness = new LocalHarness({
      registry, hooks, workspace: input.workspace,
      mainModelId: harness.mainModelId, subagentModelId: harness.subagentModelId,
      tools: loopTools, createContext: createLoopContext, permissionMode: harness.permissionMode,
      maxIterationsMain: config.maxIterations.main,
      maxIterationsSubagent: config.maxIterations.subagent,
      loopMode: true,
      approve: options.approvalPolicy === "deny"
        ? () => "deny" as ApprovalDecision
        : (request, approvalSignal) => approvals.request(request, approvalSignal),
    });
    try {
      yield* loopHarness.main.loop.run({ prompt: input.prompt, signal: input.signal });
      if (compactionInputTokens > 0 || compactionOutputTokens > 0) {
        yield {
          type: "usage",
          inputTokens: compactionInputTokens,
          outputTokens: compactionOutputTokens,
          totalInputTokens: compactionInputTokens,
          totalOutputTokens: compactionOutputTokens,
        };
      }
    } finally {
      loopHarness.dispose();
    }
  };

  const loopStore = new LoopStore({ workspace });
  const loopOrchestrator = new LoopOrchestrator({
    workspace,
    config: config.loop,
    persistence: loopStore,
    hallucinationGuard,
    prepareWorkspace: (input) => prepareLoopWorkspace(input),
    inferVerification: inferVerificationPlan,
    runWorker: ({ workspace: executionWorkspace, prompt, signal }) =>
      runLoopWorker({ workspace: executionWorkspace, prompt, signal }),
    runVerifier: runVerificationPlan,
    confirmBudget: async (state, dimensions, signal) => {
      if (options.approvalPolicy === "deny") return "unavailable";
      const reached = dimensions.map((dimension) => dimension === "cycles"
        ? `${state.budget.cyclesUsed} cycles`
        : `${state.budget.inputTokens + state.budget.outputTokens} tokens`).join(" and ");
      const next = dimensions.map((dimension) => dimension === "cycles"
        ? `${state.budget.cycleCheckpoint + state.config.cycleStep} cycles`
        : `${state.budget.tokenCheckpoint + state.config.tokenStep} tokens`).join(" and ");
      const latestVerification = state.cycles.at(-1)?.verification.summary ?? "No host verification evidence yet.";
      const answers = await questions.ask([{
        header: "Loop budget",
        question: `Loop ${state.loopId} reached ${reached}. Latest verification: ${latestVerification} Continue until the next checkpoint (${next})?`,
        options: [
          { label: "Continue", description: "Extend only the reached budget tranche and keep looping." },
          { label: "Stop", description: "End this loop as budget exhausted." },
        ],
      }], signal);
      return answers[0] === "Continue" ? "approved" : "rejected";
    },
    fingerprint: workspaceFingerprint,
    idFactory: () => `loop-${new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 17)}-${randomUUID().slice(0, 8)}`,
  });
  const goalOrchestrator = new GoalOrchestrator({
    workspace,
    registry,
    plannerModelId: mainModel,
    classifierModelId: mainModel,
    skepticCount: 3,
    maxRounds: 5,
    maxStallStreak: 2,
    runWorker: ({ workspace: goalWorkspace, prompt, signal }) =>
      runLoopWorker({ workspace: goalWorkspace, prompt, signal }),
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
    runLoop: (goal, signal) => runLoopSession(loopOrchestrator, goal, signal),
    runGoal: (goal, signal) => runGoalSession(goalOrchestrator, goal, signal),
    mcp: async (command, signal) => {
      signal.throwIfAborted();
      const manager = mcpManager!;
      if (command.action === "status") return redactSecrets(formatMcpStatus(manager), secrets);
      if (command.action === "tools") return redactSecrets(formatMcpTools(manager, command.target), secrets);
      if (command.action === "reconnect") {
        const summary = await manager.reconnect(command.target);
        syncMcpTools();
        return redactSecrets(formatMcpReconnect(summary), secrets);
      }

      const enabled = command.action === "enable";
      const summaries = manager.listServers();
      const targets = command.target === "all"
        ? summaries.filter((server) => enabled ? server.status === "disabled" : server.status !== "disabled")
        : summaries.filter((server) => server.name === command.target);
      if (targets.length === 0) {
        if (command.target === "all") return `All MCP servers are already ${enabled ? "enabled" : "disabled"}.`;
        throw new Error(`MCP server "${command.target}" not found`);
      }
      if (command.target !== "all") {
        const current = targets[0]!;
        if ((enabled && current.status !== "disabled") || (!enabled && current.status === "disabled")) {
          return `MCP server "${command.target}" is already ${enabled ? "enabled" : "disabled"}.`;
        }
      }
      for (const target of targets) {
        signal.throwIfAborted();
        await setProjectMcpServerDisabled(workspace, target.name, !enabled);
        await manager.setEnabled(target.name, enabled);
      }
      syncMcpTools();
      const action = enabled ? "Enabled" : "Disabled";
      return command.target === "all"
        ? `${action} ${targets.length} MCP server${targets.length === 1 ? "" : "s"}.`
        : `${action} MCP server "${command.target}".`;
    },
    setModel: async (role, id) => { harness.setModel(role, id); await persist(); },
    setPermissionMode: async (mode) => { harness.setPermissionMode(mode); await persist(); },
    compact: async (signal) => { const changed = await harness.main.context.compact(signal); if (changed) await persist(); return changed; },
    initialize: () => initializeFlavor(workspace, config),
    config: () => ({
      ...config, sources: loaded.sources,
      diagnostics: [...diagnostics, ...pluginHost.diagnostics.map((item) => `${item.plugin}: ${item.message}`),
        ...skills.diagnostics.map((item) => `${item.path}: ${item.message}`)].map((item) => redactSecrets(item, secrets)),
    }),
    skills: () => skills.discover(),
    reloadSkills: async () => {
      const current = await loadConfig({ cwd: workspace, home, environment });
      skills.setDisabledNames(current.config.skills.disabled);
      await skills.refresh();
    },
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
          return `  ${time}  ${entry.sessionId}  ${entry.tool ?? entry.model ?? "-"}  ${entry.errorCode ?? "-"}: ${entry.errorMessage ?? "-"}`;
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
    clearContext: async () => {
      harness.main.context.clear();
      memoryCursor = 0;
      taskPlan = undefined;
      taskGraph = undefined;
      taskStates = {};
      taskResults = {};
      for (const key of Object.keys(subagentStartedAt)) delete subagentStartedAt[key];
      for (const key of Object.keys(subagentElapsedMs)) delete subagentElapsedMs[key];
      sessionId = `session-${new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 17)}-${randomUUID().slice(0, 8)}`;
      createdAt = new Date().toISOString();
      timelineState = createTranscriptState();
      await persist();
      emitOutput({ type: "tasks", snapshot: { subagents: { states: {} } } });
    },
    memory: async () => {
      if (memoryStore === undefined) return "Long-term memory is disabled.";
      const entries = await memoryStore.list();
      return entries.length === 0
        ? `No long-term memories stored.\nPath: ${memoryStore.path}`
        : `Path: ${memoryStore.path}\n\n${renderMemoryDocument(entries)}`;
    },
    remember: async (type, text) => {
      if (memoryStore === undefined) return "Long-term memory is disabled.";
      const result = await memoryStore.remember({ type, content: text });
      return result.added
        ? `Remembered ${result.entry.type} memory ${result.entry.id}.`
        : `Memory already exists or the ${config.memory.maxEntries}-entry limit was reached.`;
    },
    forget: async (query) => {
      if (memoryStore === undefined) return "Long-term memory is disabled.";
      const removed = await memoryStore.forget(query);
      return removed === 0 ? "No matching memory found." : `Forgot ${removed} memory ${removed === 1 ? "entry" : "entries"}.`;
    },
    pluginCommands: () => [...pluginCommands.keys()].sort(),
    runPluginCommand: async (name, args, signal) => {
      const handler = pluginCommands.get(name);
      if (handler === undefined) throw new Error(`Plugin command /${name} is no longer registered.`);
      signal.throwIfAborted();
      return awaitWithSignal(Promise.resolve(handler(args, { workspace, signal })), signal);
    },
    output: emitOutput,
    questions,
    async login() {
      // If any provider has an apiKey, user is already authenticated
      const apiKeyProvider = Object.entries(config.providers)
        .find(([, p]) => p.apiKey !== undefined);
      if (apiKeyProvider !== undefined) {
        return `Already authenticated — provider "${apiKeyProvider[0]}" has an API key configured. Use /logout to clear it.`;
      }

      // Pick the provider to authenticate: prefer the main agent's provider
      let providerName: string | undefined;
      let providerConfig: ProviderRuntimeConfig | undefined;
      const mainModel = config.agents?.main?.model;
      if (mainModel !== undefined) {
        const mainProvider = safeProvider(mainModel);
        if (config.providers[mainProvider] !== undefined) {
          providerName = mainProvider;
          providerConfig = config.providers[mainProvider];
        }
      }
      // Fallback: first provider without an apiKey, or default to "openai"
      if (providerName === undefined) {
        const firstWithoutKey = Object.entries(config.providers)
          .find(([, p]) => p.apiKey === undefined);
        providerName = firstWithoutKey?.[0] ?? "openai";
        providerConfig = firstWithoutKey?.[1];
      }

      const oauthConfig = providerConfig !== undefined
        ? resolveOAuthConfig(providerConfig)
        : getOAuthDefaults();

      if (oauthConfig === undefined) {
        return `Provider "${providerName}" is missing authorizationUrl, tokenUrl, or clientId.`;
      }

      try {
        const tokenStore = createFileTokenStore(join(home, ".flavor-code", "auth.json"));
        const oauth = new OAuthCallbackAuthProvider({
          authorizationUrl: oauthConfig.authorizationUrl,
          tokenUrl: oauthConfig.tokenUrl,
          clientId: oauthConfig.clientId,
          ...(oauthConfig.scope === undefined ? {} : { scope: oauthConfig.scope }),
          store: tokenStore,
        });
        const result = await oauth.resolve(providerName);
        return `Authenticated to "${providerName}". Token expires ${result.expiresAt ?? "unknown"}. Restart flavor-code for the new token to take effect.`;
      } catch (error) {
        return `Login failed: ${message(error)}`;
      }
    },
  };
  const session = new FlavorSession(services);
  let disposed = false;
  return {
    session, services, approvals, restoredTranscript,
    get sessionId() { return sessionId; },
    get diagnostics() { return diagnostics.map((item) => redactSecrets(item, secrets)); },
    async dispose() {
      if (disposed) return;
      disposed = true;
      await memoryCoordinator?.flush();
      await persist();
      await persistTail;
      auditLogger.close();
      await cleanupProduction(approvals, questions, pluginHost, mcpManager, harness);
    },
  };
  } catch (primaryError) {
    try { await cleanupProduction(approvals, questions, pluginHost, mcpManager, harnessCreated ? harness : undefined); }
    catch (cleanupError) { attachCleanupError(primaryError, cleanupError); }
    throw primaryError;
  }
}

function formatMcpStatus(manager: McpManager): string {
  const servers = manager.listServers();
  if (servers.length === 0) {
    return "No MCP servers configured. Add them under mcpServers in .flavor/flavor.json.";
  }
  const lines = servers.map((server) => {
    const detail = server.error === undefined ? "" : ` - ${server.error}`;
    return `${server.name}  ${server.status}  ${server.transport}  ${server.toolCount} tool${server.toolCount === 1 ? "" : "s"}${detail}`;
  });
  return [
    `MCP servers (${servers.length}):`,
    ...lines.map((line) => `  ${line}`),
    "",
    "Commands: /mcp tools <server> | /mcp reconnect <server> | /mcp enable|disable [server|all]",
  ].join("\n");
}

function formatMcpTools(manager: McpManager, serverName: string): string {
  const tools = manager.toolsFor(serverName);
  if (tools.length === 0) return `MCP server "${serverName}" exposes no tools.`;
  const lines = tools.flatMap((tool) => [
    `- ${tool.name} -> ${tool.generatedName}`,
    ...(tool.description === undefined ? [] : [`  ${tool.description}`]),
    `  input: ${JSON.stringify(tool.inputSchema)}`,
  ]);
  return [`MCP tools for "${serverName}" (${tools.length}):`, ...lines].join("\n");
}

function formatMcpReconnect(server: McpServerSummary): string {
  if (server.status === "connected") {
    return `Reconnected MCP server "${server.name}" (${server.toolCount} tool${server.toolCount === 1 ? "" : "s"}).`;
  }
  if (server.status === "disabled") return `MCP server "${server.name}" is disabled. Enable it before reconnecting.`;
  return `Failed to reconnect MCP server "${server.name}": ${server.error ?? "unknown error"}`;
}

async function* runLoopSession(
  orchestrator: LoopOrchestrator, goal: string, signal: AbortSignal,
): AsyncIterable<AgentEvent> {
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  for await (const event of orchestrator.run({ goal, signal })) {
    if (event.type === "worker-event") {
      if (event.event.type === "usage") {
        totalInputTokens += event.event.inputTokens;
        totalOutputTokens += event.event.outputTokens;
        yield {
          ...event.event,
          totalInputTokens,
          totalOutputTokens,
        };
      } else if (event.event.type !== "done") yield event.event;
      continue;
    }
    yield loopProgressEvent(event);
    if (event.type === "loop-terminal") {
      yield { type: "done", usage: { inputTokens: totalInputTokens, outputTokens: totalOutputTokens } };
    }
  }
}

function loopProgressEvent(event: Exclude<LoopRuntimeEvent, { type: "worker-event" }>): AgentEvent {
  if (event.type === "loop-resolved") {
    return {
      type: "loop-progress", loopId: event.loopId, phase: "resolved", state: "info",
      message: event.verifierCommands.length === 0
        ? `Using ${event.isolation} workspace; verifier discovery is required in the first cycle.`
        : `Using ${event.isolation} workspace; verifier: ${event.verifierCommands.join(" && ")}.`,
    };
  }
  if (event.type === "loop-cycle-start") {
    return {
      type: "loop-progress", loopId: event.loopId, phase: "cycle", state: "running",
      message: `Cycle ${event.cycle} is running.`,
    };
  }
  if (event.type === "loop-verification") {
    return {
      type: "loop-progress", loopId: event.loopId, phase: "verification",
      state: event.evidence.passed ? "completed" : "running",
      message: `Cycle ${event.cycle}: ${event.evidence.summary}`,
    };
  }
  if (event.type === "loop-budget") {
    return {
      type: "loop-progress", loopId: event.loopId, phase: "budget", state: "info",
      message: `Confirmation required for ${event.dimensions.join(" and ")} budget.`,
    };
  }
  return {
    type: "loop-progress", loopId: event.loopId, phase: "terminal",
    state: terminalProgressState(event.status),
    message: `Loop ${event.status}: ${event.reason}`,
  };
}

function terminalProgressState(status: Exclude<LoopStatus, "running">): "completed" | "failed" | "cancelled" | "info" {
  if (status === "succeeded") return "completed";
  if (status === "cancelled") return "cancelled";
  if (status === "needs_human") return "info";
  return "failed";
}

async function workspaceFingerprint(workspace: string): Promise<string> {
  const hash = createHash("sha256");
  const diff = await execFileNoThrow(
    "git", ["-C", workspace, "diff", "--no-ext-diff", "--binary", "HEAD"],
    { timeout: 30_000, useCwd: false },
  );
  if (diff.code !== 0) return hash.update("non-git-workspace").digest("hex");
  hash.update(diff.stdout);
  const untracked = await execFileNoThrow(
    "git", ["-C", workspace, "ls-files", "--others", "--exclude-standard", "-z"],
    { timeout: 30_000, useCwd: false },
  );
  let remaining = 5 * 1024 * 1024;
  for (const name of untracked.stdout.split("\0").filter(Boolean).sort()) {
    if (name === ".flavor/loops" || name.startsWith(".flavor/loops/")) continue;
    const path = resolve(workspace, name);
    const relativePath = relative(resolve(workspace), path);
    if (relativePath === ".." || relativePath.startsWith(`..${sep}`)) continue;
    hash.update(name);
    if (remaining <= 0) continue;
    try {
      const content = await readFile(path);
      const slice = content.subarray(0, remaining);
      hash.update(slice);
      remaining -= slice.length;
    } catch { /* A concurrently removed or non-file path is represented by its name. */ }
  }
  return hash.digest("hex");
}

async function* runMain(
  harness: LocalHarness, skills: SkillRegistry, prompt: string, signal: AbortSignal, setupError?: string,
): AsyncIterable<AgentEvent> {
  let additionalContext: string | undefined;
  try {
    if (setupError !== undefined) {
      harness.main.context.append({ role: "user", content: prompt });
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
  parentContext: ContextManager,
): Promise<unknown> {
  return harness.runSubagent(task, async (child, childSignal) => {
    const skill = await skills.match(task.description);
    const skillContext = skill === undefined ? undefined : `Matched skill: ${skill.name}\n${await skills.loadBody(skill)}`;
    const repair = attempt === 2 ? " Your previous response was invalid. Return only one strict JSON object." : "";
    const prompt = [
      buildSubagentDirective(),
      ...(skillContext === undefined ? [] : [skillContext]),
      `Complete task ${task.id}: ${task.description}`,
      `Expected outputs: ${task.expectedOutputs.join("; ")}`,
      `Verification: ${task.verification.join("; ")}`,
      `For completed work, finish by calling TaskOutput. Otherwise return only JSON matching these fields: ${Object.keys(SubagentResultSchema.shape).join(", ")}.${repair}`,
    ].join("\n");
    for await (const event of child.loop.run({ prompt, signal: childSignal })) {
      if (event.type === "error") throw new Error(event.error.message);
      if (event.type === "tool-end" && event.name === "TaskOutput" && event.result.ok) {
        const completed = subagentResultFromTaskOutput(task.id, event.result.output);
        if (completed !== undefined) return completed;
      }
    }
    return parseFinalSubagentMessage(child.context.snapshot().messages);
  }, signal, parentContext);
}

async function registerConfiguredAdapters(
  providers: Record<string, ProviderRuntimeConfig>,
  registry: ModelRegistry,
  environment: NodeJS.ProcessEnv,
  diagnostics: string[],
  home: string,
): Promise<RegisteredProvider[]> {
  const configured = { ...providers };
  if (configured.openai === undefined && environment.OPENAI_API_KEY) configured.openai = { type: "openai", apiKey: environment.OPENAI_API_KEY };
  if (configured.anthropic === undefined && environment.ANTHROPIC_API_KEY) configured.anthropic = { type: "anthropic", apiKey: environment.ANTHROPIC_API_KEY };
  const oauthTokenStore = createFileTokenStore(join(home, ".flavor-code", "auth.json"));
  const registered: RegisteredProvider[] = [];
  for (const [name, provider] of Object.entries(configured)) {
    try {
      // Step 1: Determine the API protocol from provider type
      let apiProtocol: "openai" | "anthropic";
      if (provider.type === "oauth-callback") {
        apiProtocol = provider.apiType ?? "openai";
      } else if (provider.type === "openai" || provider.type === "openai-compatible") {
        apiProtocol = "openai";
      } else if (provider.type === "anthropic") {
        apiProtocol = "anthropic";
      } else {
        diagnostics.push(`Provider "${name}" has unsupported type "${provider.type}".`);
        continue;
      }

      // Step 2: Resolve the API key (apiKey config → OAuth PKCE → env vars)
      let apiKey: string | undefined;
      if (provider.apiKey !== undefined) {
        apiKey = provider.apiKey;
      } else {
        // Try OAuth PKCE (uses OAUTH_DEFAULTS when no explicit OAuth fields are set)
        const oauthConfig = resolveOAuthConfig(provider);
        if (oauthConfig !== undefined) {
          const oauth = new OAuthCallbackAuthProvider({
            authorizationUrl: oauthConfig.authorizationUrl,
            tokenUrl: oauthConfig.tokenUrl,
            clientId: oauthConfig.clientId,
            ...(oauthConfig.scope === undefined ? {} : { scope: oauthConfig.scope }),
            store: oauthTokenStore,
          });
          const result = await oauth.resolve(name);
          apiKey = result.headers.authorization?.replace(/^Bearer /, "") ?? "";
        }

        // Fallback to environment variables
        if (apiKey === undefined && apiProtocol === "openai") {
          apiKey = environment.OPENAI_API_KEY;
        }
        if (apiKey === undefined && apiProtocol === "anthropic") {
          apiKey = environment.ANTHROPIC_API_KEY;
        }

        if (apiKey === undefined) {
          const hasOAuthFields = provider.authorizationUrl !== undefined
            || provider.tokenUrl !== undefined
            || provider.clientId !== undefined;
          if (hasOAuthFields) {
            diagnostics.push(
              `Provider "${name}" has incomplete OAuth configuration. Set authorizationUrl, tokenUrl, and clientId together, or provide an apiKey.`,
            );
          } else {
            const envVar = apiProtocol === "openai" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY";
            diagnostics.push(
              `Provider "${name}" requires apiKey, ${envVar}, or OAuth PKCE configuration. Use /login to authenticate.`,
            );
          }
          continue;
        }
      }

      // Step 3: Create the adapter
      const adapterOptions = {
        apiKey,
        ...(provider.baseURL === undefined ? {} : { baseURL: provider.baseURL }),
        ...(provider.maxOutputTokens === undefined ? {} : { maxOutputTokens: provider.maxOutputTokens }),
      };
      const adapter: ModelAdapter = apiProtocol === "anthropic"
        ? new AnthropicModelAdapter(adapterOptions)
        : new OpenAIModelAdapter(adapterOptions);

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
  maxOutputTokens?: number | undefined;
  // OAuth PKCE fields — all have built-in defaults when type=oauth-callback
  apiType?: "openai" | "anthropic" | undefined;
  authorizationUrl?: string | undefined;
  tokenUrl?: string | undefined;
  clientId?: string | undefined;
  scope?: string | undefined;
}

// Built-in OAuth defaults — override via OAUTH_* env vars for remote auth servers.
// Deferred to a function so .env values loaded at runtime are visible.
function getOAuthDefaults(): ResolvedOAuthConfig {
  return {
    authorizationUrl: process.env.OAUTH_AUTHORIZATION_URL ?? "",
    tokenUrl: process.env.OAUTH_TOKEN_URL ?? "",
    clientId: process.env.OAUTH_CLIENT_ID ?? "flavor-code-cli",
    scope: process.env.OAUTH_SCOPE ?? "models:read models:use",
  };
}

interface ResolvedOAuthConfig {
  authorizationUrl: string;
  tokenUrl: string;
  clientId: string;
  scope?: string;
}

function resolveOAuthConfig(provider: ProviderRuntimeConfig): ResolvedOAuthConfig | undefined {
  if (provider.apiKey !== undefined) return undefined; // apiKey mode, no PKCE needed

  const hasExplicitOAuth = provider.authorizationUrl !== undefined
    || provider.tokenUrl !== undefined
    || provider.clientId !== undefined
    || provider.scope !== undefined;

  if (hasExplicitOAuth) {
    // Merge flavor.json fields with env defaults — flavor.json wins for each field
    const defaults = getOAuthDefaults();
    const authorizationUrl = provider.authorizationUrl ?? defaults.authorizationUrl;
    const tokenUrl = provider.tokenUrl ?? defaults.tokenUrl;
    const clientId = provider.clientId ?? defaults.clientId;
    const scope = provider.scope ?? defaults.scope;

    if (!authorizationUrl || !tokenUrl || !clientId) return undefined;

    return { authorizationUrl, tokenUrl, clientId, ...(scope ? { scope } : {}) };
  }

  // No OAuth config in flavor.json — use env defaults (OAUTH_* vars).
  // If the user set them, they want PKCE regardless of provider type.
  return getOAuthDefaults();
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
  if (type === "openai" || type === "oauth-callback") return "gpt-5";
  if (type === "anthropic") return "claude-opus-4-5";
  return undefined;
}
function providerCheapDefault(type: string | undefined): string | undefined {
  if (type === "openai" || type === "oauth-callback") return "gpt-5-mini";
  if (type === "anthropic") return "claude-sonnet-4-5";
  return undefined;
}
function safeProvider(modelId: string): string {
  try { return parseModelId(modelId).provider; } catch { return modelId.split(":", 1)[0] ?? modelId; }
}

function promptEnvironmentValue(value: string | undefined): string {
  const normalized = value?.trim();
  return normalized ? normalized : "unknown";
}

async function detectGitRepository(workspace: string): Promise<boolean | "unknown"> {
  const result = await execFileNoThrow(
    "git",
    ["-C", workspace, "rev-parse", "--is-inside-work-tree"],
    { timeout: 2_000, useCwd: false },
  );
  if (result.code === 0) return result.stdout.trim() === "true";
  if (/not a git repository/i.test(`${result.stderr}\n${result.error ?? ""}`)) return false;
  return "unknown";
}

async function generateMemoryExtraction(
  registry: ModelRegistry,
  modelId: string,
  prompt: string,
  signal: AbortSignal,
): Promise<string> {
  const { adapter, model } = registry.get(modelId);
  let output = "";
  for await (const event of adapter.stream({
    model,
    messages: [{ role: "user", content: prompt }],
    tools: [],
    signal,
  })) {
    if (event.type === "text") output += event.text;
    else if (event.type === "error") throw new Error(event.error.message);
    else if (event.type === "tool-call" || event.type === "invalid-tool-call") {
      throw new Error("Memory extractor attempted an unsupported tool call");
    }
  }
  if (output.trim().length === 0) throw new Error("Memory extractor returned no text");
  return output;
}

async function optionalText(path: string): Promise<string | undefined> {
  try { return await readFile(path, "utf8"); }
  catch (error) { if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return undefined; throw error; }
}

function remove<T>(items: T[], item: T): void { const index = items.indexOf(item); if (index >= 0) items.splice(index, 1); }
function storedConversation(snapshot: ContextSnapshot): SessionDocument["conversation"] {
  return {
    ...(snapshot.compact === undefined ? {} : { compact: snapshot.compact }),
    messages: snapshot.messages.filter((message) => message.role !== "system").map((message) => ({
      role: message.role as "user" | "assistant" | "tool", content: message.content,
      ...(message.toolCallId === undefined ? {} : { toolCallId: message.toolCallId }),
      ...(message.toolCalls === undefined ? {} : { toolCalls: message.toolCalls }),
    })),
  };
}

async function cleanupProduction(
  approvals: ApprovalBridge, questions: QuestionBridge, pluginHost: PluginHost,
  mcpManager: McpManager | undefined, harness: LocalHarness | undefined,
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
    try { await mcpManager?.close(); }
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

async function* runGoalSession(
  orchestrator: GoalOrchestrator, goal: string, signal: AbortSignal,
): AsyncIterable<AgentEvent> {
  for await (const event of orchestrator.run({ goal, signal })) {
    if (event.type === "goal-plan-created") {
      yield { type: "warning", message: `Goal plan created (${event.plan.kind}) with ${event.plan.criteria.length} acceptance criteria.` };
      yield { type: "warning", message: `Plan file: ${event.planPath}` };
      if (event.plan.approach) {
        yield { type: "warning", message: `Approach: ${event.plan.approach}` };
      }
      continue;
    }
    if (event.type === "goal-plan-failed") {
      yield { type: "error", error: { code: "unknown", message: event.reason } };
      yield { type: "done", usage: { inputTokens: 0, outputTokens: 0 } };
      return;
    }
    if (event.type === "goal-worker-start") {
      yield { type: "warning", message: `Goal round ${event.round}: executing...` };
      continue;
    }
    if (event.type === "goal-verification-start") {
      yield { type: "warning", message: `Goal round ${event.round}: verification panel (${3} skeptics) auditing...` };
      continue;
    }
    if (event.type === "goal-verdict") {
      if (event.outcome.type === "achieved") {
        yield { type: "warning", message: `Verdict: ACHIEVED. ${event.outcome.summary}` };
      } else if (event.outcome.type === "not_achieved") {
        yield { type: "warning", message: `Verdict: NOT ACHIEVED. ${event.outcome.summary}` };
      } else {
        yield { type: "warning", message: `Verdict: BLOCKED. ${event.outcome.reason}` };
      }
      continue;
    }
    if (event.type === "goal-complete") {
      yield { type: "warning", message: `Goal complete! ${event.summary}` };
      yield { type: "done", usage: { inputTokens: 0, outputTokens: 0 } };
      return;
    }
    if (event.type === "goal-failed") {
      yield { type: "error", error: { code: "unknown", message: event.reason } };
      yield { type: "done", usage: { inputTokens: 0, outputTokens: 0 } };
      return;
    }
    if (event.type === "goal-paused") {
      yield { type: "warning", message: `Goal paused: ${event.reason}` };
      continue;
    }
    if (event.type === "goal-stalled") {
      yield { type: "warning", message: `Goal stalled: ${event.reason}` };
      continue;
    }
  }
  yield { type: "done", usage: { inputTokens: 0, outputTokens: 0 } };
}
