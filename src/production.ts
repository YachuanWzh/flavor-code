import { readFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { homedir, release as osRelease, tmpdir, version as osVersion } from "node:os";
import { basename, join, relative, resolve, sep } from "node:path";

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
import { WorkspaceInstructions } from "./context/workspace-instructions.js";
import { summarizeWithModel } from "./context/summarizer.js";
import { LocalHarness } from "./harness/local.js";
import { HarnessJournal } from "./harness/journal.js";
import { HookBus } from "./hooks/bus.js";
import { HOOK_EVENT_NAMES, type HookDecision, type HookEventName } from "./hooks/types.js";
import { createIncidentReporter } from "./incidents/reporter.js";
import { createIslandControlServer, type IslandControlServer } from "./island/control-server.js";
import { createEvolveService } from "./evolve/service.js";
import { initializeFlavor } from "./init/project.js";
import { LoopOrchestrator, type LoopRuntimeEvent } from "./loop/orchestrator.js";
import { GoalOrchestrator } from "./goal/orchestrator.js";
import { GoalStore } from "./goal/store.js";
import { prepareLoopWorkspace } from "./loop/isolation.js";
import { LoopStore } from "./loop/store.js";
import type { LoopStatus, LoopVerificationEvidence } from "./loop/types.js";
import { inferVerificationPlan, runVerificationPlan } from "./loop/verifier.js";
import { AnthropicModelAdapter, CLAUDE_CLIENT_HEADERS } from "./models/anthropic.js";
import { isDashScopeBaseURL, resolveCacheProfile, type CacheStrategy } from "./models/cache-profile.js";
import { OpenAIModelAdapter } from "./models/openai.js";
import { ModelRegistry, parseModelId } from "./models/registry.js";
import { modelContentText, type ModelAdapter, type ModelMessage } from "./models/types.js";
import { connectMcpServers, McpManager, type McpClientFactory, type McpServerSummary } from "./mcp/client.js";
import { connectSdkMcpClient } from "./mcp/sdk.js";
import { OAuthCallbackAuthProvider } from "./auth/oauth.js";
import { createFileTokenStore, retainOnlyCredentials } from "./auth/store.js";
import { oauthCredentialId } from "./auth/oauth-config.js";
import type { AuthResult, OAuthLlmConfig } from "./auth/types.js";
import type { PermissionProfile, PermissionRequest } from "./permissions/engine.js";
import { loadPermissionPolicy } from "./permissions/policy.js";
import { buildCurrentDateSection, buildRuntimeEnvironmentSection, buildSubagentDirective, buildSystemPrompt, type PromptEnvironment } from "./prompts/system.js";
import type { ApprovalDecision } from "./tools/runtime.js";
import { PluginHost } from "./plugins/host.js";
import type { PluginCommandHandler } from "./plugins/types.js";
import { SkillRegistry } from "./skills/registry.js";
import { createSkillResourceTool, createSkillTool } from "./skills/tool.js";
import { expandSkillArguments } from "./skills/arguments.js";
import { SESSION_VERSION, SessionStore, type SessionDocument } from "./session/store.js";
import { SessionHistory } from "./session/tree.js";
import { ProjectSleepOrganizer, ProjectSleepScheduler, localDateKey } from "./sleep/organizer.js";
import {
  createApplyPatchTool,
  createEditTool,
  createReadTool,
  createWriteTool,
  FileObservationStore,
  type FileWriteProposal,
} from "./tools/files.js";
import { createGlobTool, createGrepTool } from "./tools/search.js";
import { createShellTool } from "./tools/shell.js";
import { createWebFetchTool, createWebSearchTool } from "./tools/web.js";
import { createLspTools } from "./tools/lsp.js";
import {
  changeSummary,
  commit as gitCommitChange,
  gitMarker,
  isGitRepository,
  stageAll,
  stagedDiff,
  uncommittedDiff,
} from "./git/service.js";
import { formatReviewReport, reviewDiff, suggestCommitMessage } from "./git/insights.js";
import { createGitHistoryTool } from "./git/tools.js";
import { createAskUserQuestionTool, hookAnswersFromUpdatedInput, QuestionBridge, type AskUserQuestionHandler } from "./tools/ask-user-question.js";
import { createTaskOutputTool } from "./tools/task-output.js";
import { createTodoWriteTool } from "./tools/todo-write.js";
import { createManagedToolManagementTools, ManagedToolStore } from "./tools/managed.js";
import type { ToolDefinition } from "./tools/types.js";
import { FlavorSession, type SessionOutput, type SessionServices } from "./ui/session.js";
import { createTranscriptState, restoreTranscriptState, transcriptReducer, type TranscriptState } from "./ui/transcript.js";
import { MVP_COMMANDS } from "./ui/commands.js";
import { resolveLanguage, languageInstruction } from "./utils/intl.js";
import { awaitWithSignal, withTimeout } from "./utils/async.js";
import { message } from "./utils/error.js";
import { execFileNoThrow } from "./utils/execFileNoThrow.js";
import { redactSecrets } from "./utils/redact.js";
import { HallucinationGuard } from "./hallucination/guard.js";
import { AuditLogger, setUsageSession, usageLogPath } from "./utils/log.js";
import { formatUsageSummary, parseUsageEntries, summarizeUsage } from "./utils/usage-summary.js";
import { MemoryCoordinator } from "./memory/coordinator.js";
import { isExplicitMemoryIntent } from "./memory/intent.js";
import { DEFAULT_MEMORY_BEHAVIOR, MemoryStore, renderMemoryDocument } from "./memory/store.js";
import { MemoryReviewBridge } from "./memory/review.js";
import { createExecutionEnvironment } from "./execution/factory.js";
import { FlavorIdeClient } from "./ide/client.js";
import { JobRegistry, type JobReadResult, type JobSnapshot } from "./jobs/registry.js";
import { TerminalService } from "./terminal/service.js";
import { createJobTools } from "./tools/jobs.js";
import { createTerminalTools } from "./tools/terminal.js";
import { palSocketAddress } from "./pals/address.js";
import { ensurePalBrokerRunning } from "./pals/broker-cli.js";
import { PalClient } from "./pals/client.js";
import { CollaborationShareGuard, createPalsTools, type PalClientLike } from "./pals/tools.js";
import { MIN_UUID_PREFIX_LENGTH, normalizePalIdentity, PalAliasSchema, PalTargetSchema, type BrokerEvent, type PalPresence } from "./pals/protocol.js";

const INTERRUPTED_TASK_PLAN_CONTEXT = [
  "The previous turn's task plan was cancelled and archived, so it is no longer active.",
  "Reassess the current query independently.",
  "If the current work needs a plan, create a fresh one with TaskPlan before using TaskUpdate.",
].join(" ");

function recoverablePalClient(client: PalClientLike, onRecovered: () => void): PalClientLike {
  let presence: PalPresence | undefined;
  let starting: Promise<PalPresence> | undefined;
  const ensure = (): Promise<PalPresence> => {
    if (presence !== undefined) return Promise.resolve(presence);
    if (starting !== undefined) return starting;
    starting = client.start().then((value) => { presence = value; onRecovered(); return value; })
      .finally(() => { starting = undefined; });
    return starting;
  };
  const invoke = async <T>(run: () => Promise<T>): Promise<T> => {
    await ensure();
    try { return await run(); }
    catch (error) {
      const detail = message(error);
      if (!/not connected|connection closed|ECONNRESET|ECONNREFUSED|EPIPE/i.test(detail)) throw error;
      presence = undefined;
      await ensure();
      return run();
    }
  };
  return {
    start: ensure,
    list: () => invoke(() => client.list()),
    rename: (alias) => invoke(() => client.rename(alias)),
    sendTask: (target, value) => invoke(() => client.sendTask(target, value)),
    sendChat: (target, value) => invoke(() => client.sendChat(target, value)),
    startCoWork: (input) => invoke(() => client.startCoWork(input)),
    coWorkAction: (action) => invoke(() => client.coWorkAction(action)),
    coWorkStatus: (coWorkId) => invoke(() => client.coWorkStatus(coWorkId)),
    integrateCoWork: (input) => invoke(() => client.integrateCoWork(input)),
    cancelCoWork: (coWorkId, reason) => invoke(() => client.cancelCoWork(coWorkId, reason)),
    subscribe: (listener) => client.subscribe(listener),
    close: async () => { presence = undefined; await client.close(); },
  };
}

/**
 * Per-step shutdown budget. On Windows a hung child-process pipe, named pipe,
 * or MCP stdio server can block one cleanup step forever; abandoning that step
 * after the budget lets the remaining steps — and process exit — proceed.
 */
export const DEFAULT_SHUTDOWN_STEP_TIMEOUT_MS = 3_000;

export interface ProductionRuntimeOptions {
  workspace?: string;
  home?: string;
  environment?: NodeJS.ProcessEnv;
  output(event: SessionOutput): void;
  onApprovalChange?(): void;
  /** Non-interactive callers must deny requests instead of waiting for input. */
  approvalPolicy?: "prompt" | "deny";
  /** Allow a protocol host to resolve tool approvals without enabling other interactive UI bridges. */
  rpcToolApprovals?: boolean;
  /** Optional pre-commit gate used by protocol hosts to stream a proposed text write before it reaches disk. */
  beforeFileCommit?(proposal: FileWriteProposal, signal: AbortSignal): Promise<void>;
  /** Resume a named session, or the latest session when true. Never resumed implicitly. */
  resumeSession?: string | true;
  /** Test and embedding seam for creating configured MCP clients. */
  mcpClientFactory?: McpClientFactory;
  /** Per-step timeout (ms) for shutdown/disposal steps so a hung cleanup cannot block process exit. */
  shutdownStepTimeoutMs?: number;
  /** Additional tools provided by embedders (e.g. desktop-only D2C tools). */
  extraTools?: readonly ToolDefinition<unknown>[];
  /** Opt into Worker/vm isolation. The compatibility default remains false
   * until sandbox capabilities cover the Node.js APIs used by bundled plugins. */
  pluginSandbox?: boolean;
  /** Optional host affordance exposed to the local Flavor Island control channel. */
  islandControl?: { focus?(): void | Promise<void> };
  /** Explicitly opt into CLI-local collaboration. Omit for print/RPC/eval callers. */
  collaboration?: {
    instanceId: string;
    alias?: string;
    /** Optional integrations degrade to diagnostics instead of blocking runtime startup. */
    optional?: boolean;
    /** Embedder-owned broker starter, used by Electron where process.argv points at the desktop entry. */
    startBroker?: (address: string) => Promise<void>;
    client?: PalClientLike;
    createClient?: (input: { instanceId: string; alias: string; projectPath: string }) => PalClientLike;
  };
}

export interface ProductionRuntime {
  session: FlavorSession;
  services: SessionServices;
  authorization: {
    permissionProfile(): PermissionProfile;
    setPermissionProfile(profile: PermissionProfile): void;
  };
  approvals: ApprovalBridge;
  memoryReviews: MemoryReviewBridge;
  diagnostics: readonly string[];
  sessionId: string;
  restoredTranscript: TranscriptState;
  jobs: { list(): readonly JobSnapshot[]; read(id: string, owner: string, cursor?: number): JobReadResult; subscribe(listener: (jobs: readonly JobSnapshot[]) => void): () => void };
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
    date: Number.isNaN(now.getTime()) ? "unknown" : localDateKey(now),
    platform: promptEnvironmentValue(input.platform ?? process.platform),
    osVersion: promptEnvironmentValue(input.osVersion ?? `${osVersion()} ${osRelease()}`),
    shell: promptEnvironmentValue(input.shell ?? process.env.ComSpec ?? process.env.SHELL),
    isGitRepository: input.isGitRepository ?? "unknown",
  };
}

export class ApprovalBridge {
  #pending: (PermissionRequest & { id: string; reason?: string }) | undefined;
  #settle: ((decision: ApprovalDecision) => void) | undefined;
  #removeAbort: (() => void) | undefined;
  readonly #onChange: (() => void) | undefined;

  constructor(onChange?: () => void) { this.#onChange = onChange; }
  get pending(): (PermissionRequest & { id: string; reason?: string }) | undefined { return this.#pending; }

  request(request: PermissionRequest & { reason?: string }, signal: AbortSignal = new AbortController().signal): Promise<ApprovalDecision> {
    if (this.#settle !== undefined) return Promise.resolve("deny");
    if (signal.aborted) return Promise.resolve("deny");
    this.#pending = { id: randomUUID(), ...request };
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
  const ide = new FlavorIdeClient({ workspace, home, environment });
  // IDE discovery, git detection, and MCP connections overlap with configuration
  // loading instead of serializing startup; each is settled at its point of use.
  const ideReady = ide.initialize();
  const gitRepository = detectGitRepository(workspace);
  const loaded = await loadConfig({ cwd: workspace, home, environment });
  const config = loaded.config;
  const mcpReady = connectMcpServers({
    servers: config.mcpServers,
    workspace,
    clientFactory: options.mcpClientFactory ?? connectSdkMcpClient,
  });
  mcpReady.catch(() => undefined); // The failure surfaces at the wiring point below.
  let mcpDiscarded = false;
  const sessionStore = new SessionStore({ workspace, maxSessions: config.maxSessions });
  const memoryStore = config.memory.enabled ? new MemoryStore({
    workspace,
    maxEntries: config.memory.maxEntries,
    maxEntryChars: config.memory.maxEntryChars,
  }) : undefined;
  const autoStoredContents: string[] = [];
  let memoryBehavior = DEFAULT_MEMORY_BEHAVIOR;
  if (memoryStore !== undefined) {
    try {
      memoryBehavior = await memoryStore.loadBehavior();
    } catch {
      memoryBehavior = DEFAULT_MEMORY_BEHAVIOR;
    }
  }
  let memoryHasRoutableEntries = false;
  let userMemoryContext: string | undefined;
  const refreshMemoryState = async (): Promise<void> => {
    if (memoryStore === undefined) {
      memoryHasRoutableEntries = false;
      userMemoryContext = undefined;
      return;
    }
    const references = await memoryStore.references();
    memoryHasRoutableEntries = references.some((reference) => reference.type !== "user");
    userMemoryContext = await memoryStore.userContext();
  };
  const memoryReviews = new MemoryReviewBridge({
    autoDismissSeconds: config.memory.reviewAutoDismissSeconds,
    remember: async (candidate) => {
      if (memoryStore === undefined) throw new Error("Long-term memory is disabled");
      if (candidate.taskId !== undefined && candidate.summary !== undefined && candidate.topicKey !== undefined
        && candidate.keywords !== undefined && candidate.scores !== undefined) {
        const result = await memoryStore.rememberForTask(candidate.taskId, {
          type: candidate.type, content: candidate.content, summary: candidate.summary,
          topicKey: candidate.topicKey, keywords: candidate.keywords, scores: candidate.scores,
        });
        if (result.added) await refreshMemoryState();
      } else {
        const result = await memoryStore.remember(candidate);
        if (result.added) await refreshMemoryState();
      }
    },
    ...(options.onApprovalChange === undefined ? {} : { onChange: options.onApprovalChange }),
    ...(memoryStore === undefined ? {} : {
      onDismiss: () => {
        memoryBehavior = { ...memoryBehavior, ignoreStreak: memoryBehavior.ignoreStreak + 1 };
        const justPaused = memoryBehavior.ignoreStreak >= config.memory.ignoreStreakLimit
          && !memoryBehavior.autoExtractPaused;
        if (justPaused) memoryBehavior = { ...memoryBehavior, autoExtractPaused: true };
        void memoryStore.saveBehavior(memoryBehavior).catch(() => undefined);
        if (justPaused) {
          emitOutput({
            type: "notice",
            message: `Long-term-memory auto-extraction paused after ${memoryBehavior.ignoreStreak} consecutive dismissals. Use /finish, /remember, or an explicit “remember” request to store memory manually.`,
          });
        }
      },
      onAccept: () => {
        if (memoryBehavior.ignoreStreak === 0 && !memoryBehavior.autoExtractPaused) return;
        memoryBehavior = { ignoreStreak: 0, autoExtractPaused: false };
        void memoryStore.saveBehavior(memoryBehavior).catch(() => undefined);
      },
    }),
  });
  const auditLogger = new AuditLogger(workspace);
  const recovered = options.resumeSession === undefined
    ? undefined
    : await sessionStore.load(options.resumeSession === true ? undefined : options.resumeSession);
  let timelineState = recovered === undefined
    ? createTranscriptState()
    : restoreTranscriptState(recovered.timeline.state);
  const restoredTranscript = restoreTranscriptState(timelineState);
  let ideSessionId: string | undefined;
  const emitOutput = (event: SessionOutput): void => {
    timelineState = transcriptReducer(timelineState, { type: "session", event });
    options.output(event);
    if (ideSessionId !== undefined) ide.publishEvent(ideSessionId, event);
  };
  const secrets = [
    ...Object.values(config.providers).map((provider) => provider.apiKey),
    ...Object.values(config.mcpServers).flatMap((server) =>
      Object.values("command" in server ? server.env : server.headers)),
    environment.OPENAI_API_KEY, environment.ANTHROPIC_API_KEY,
  ].filter((value): value is string => typeof value === "string" && value.length > 0);
  let hookSessionId: string | undefined;
  let islandControlMetadata: {
    endpoint: string;
    token: string;
    capabilities: readonly string[];
  } | undefined;
  const hooks = new HookBus({
    eventContext: () => ({
      protocolVersion: 2,
      workspace,
      ...(hookSessionId === undefined ? {} : { sessionId: hookSessionId }),
      ...(islandControlMetadata === undefined ? {} : {
        islandControlEndpoint: islandControlMetadata.endpoint,
        islandControlToken: islandControlMetadata.token,
        islandControlCapabilities: islandControlMetadata.capabilities,
      }),
    }),
  });

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
  const permissionPolicy = await loadPermissionPolicy({
    workspace,
    home,
    ...(environment.FLAVOR_MANAGED_PERMISSIONS === undefined
      ? {}
      : { managedPath: environment.FLAVOR_MANAGED_PERMISSIONS }),
  });
  diagnostics.push(...permissionPolicy.diagnostics);
  const approvals = new ApprovalBridge(options.onApprovalChange);
  const resolveToolApproval = options.approvalPolicy === "deny" && options.rpcToolApprovals !== true
    ? () => "deny" as ApprovalDecision
    : (request: PermissionRequest & { reason?: string }, signal: AbortSignal) => approvals.request(request, signal);
  const relayQuestions = async (qs: Parameters<AskUserQuestionHandler>[0], signal: AbortSignal) => {
    if (options.approvalPolicy === "deny") throw new Error("AskUserQuestion is not available in non-interactive mode");
    // Hook-relayed UIs (e.g. the Flavor Island desktop app) get first refusal:
    // they answer an AskUserQuestion PermissionRequest whose updatedInput
    // carries the answers keyed by question text. Anything less than a complete
    // answer set falls through to the terminal prompt below.
    if (hooks.hasListeners("PermissionRequest")) {
      let decision: HookDecision;
      try {
        decision = await hooks.emit({
          version: 1,
          type: "PermissionRequest",
          payload: { tool: "AskUserQuestion", input: { questions: qs }, agent: "main" },
        }, signal);
      } catch (error) {
        if (signal.aborted) throw error;
        decision = { decision: "ask", reason: message(error) };
      }
      if (decision.decision === "deny") throw new Error(decision.reason ?? "User skipped the question");
      const hookAnswers = hookAnswersFromUpdatedInput(decision.updatedInput, qs);
      if (hookAnswers !== undefined) return hookAnswers;
    }
    return undefined;
  };
  const questions = new QuestionBridge(options.onApprovalChange, relayQuestions);
  const askUserQuestionHandler: AskUserQuestionHandler = (qs, signal) => questions.ask(qs, signal);
  const executionEnvironment = createExecutionEnvironment(workspace, config.execution);
  const jobs = new JobRegistry();
  const terminals = new TerminalService(workspace, { jobs });
  const observations = new FileObservationStore();
  const workspaceInstructions = new WorkspaceInstructions(workspace);
  const fileMutationOptions = {
    observations,
    ...(options.beforeFileCommit === undefined ? {} : { beforeCommit: options.beforeFileCommit }),
  };
  const tools: ToolDefinition<unknown>[] = [
    createReadTool(workspace, { observations }),
    createWriteTool(workspace, fileMutationOptions),
    createEditTool(workspace, fileMutationOptions),
    createApplyPatchTool(workspace, fileMutationOptions),
    createGlobTool(workspace), createGrepTool(workspace), createGitHistoryTool(workspace), createShellTool(workspace, {
      jobs,
      ...(executionEnvironment === undefined ? {} : { executionEnvironment }),
    }),
    createWebFetchTool(), createWebSearchTool(), ...createJobTools(jobs), ...createTerminalTools(terminals, workspace),
    ...createLspTools(workspace, {
      onStatus: (message) => emitOutput({ type: "notice", message }),
    }),
    ...(options.approvalPolicy === "deny" ? [] : [createAskUserQuestionTool(askUserQuestionHandler)]),
    createTaskOutputTool(),
    createTodoWriteTool(),
  ];
  const managedToolStore = new ManagedToolStore({ workspace, home });
  await managedToolStore.load();
  diagnostics.push(...managedToolStore.diagnostics);
  let managedTools: ToolDefinition<unknown>[] = [];
  let harness!: LocalHarness;
  let harnessCreated = false;
  const syncManagedTools = (): void => {
    for (const tool of managedTools) remove(tools, tool);
    managedTools = [];
    for (const tool of managedToolStore.definitions()) {
      const conflict = tools.find((candidate) => sameToolName(candidate.name, tool.name));
      if (conflict !== undefined) {
        const diagnostic = `Managed tool "${tool.name}" conflicts with existing tool "${conflict.name}" and was skipped`;
        if (!diagnostics.includes(diagnostic)) diagnostics.push(diagnostic);
        continue;
      }
      tools.push(tool);
      managedTools.push(tool);
    }
    if (harnessCreated) harness.replaceMainTools(tools);
  };
  tools.push(...createManagedToolManagementTools({
    store: managedToolStore,
    conflict: (name) => {
      const existing = tools.find((candidate) => sameToolName(candidate.name, name));
      return existing === undefined ? undefined : `existing tool "${existing.name}"`;
    },
    onChanged: syncManagedTools,
  }));
  syncManagedTools();
  const pluginSkillRoots: string[] = [];
  const pluginHooks: HookEventName[] = [];
  const pluginCommands = new Map<string, { handler: PluginCommandHandler; description?: string }>();
  const mcpTools: ToolDefinition<unknown>[] = [];
  let mcpManager: McpManager | undefined;

  const registration = await registerConfiguredAdapters(config.providers, registry, environment, diagnostics, home);
  const registeredProviders = registration.registered;
  let effectiveLlm = registration.effectiveLlm;

  const pluginHost = new PluginHost({
    globalPluginDirs: [join(home, ".flavor-code", "plugins")],
    projectPluginDirs: [join(workspace, ".flavor", "plugins")],
    config,
    // Existing project plugins (including astgraph and superharness) use Node.js
    // built-ins. The Worker/vm sandbox deliberately blocks those imports, so it
    // must stay opt-in until equivalent mediated capabilities are available.
    sandbox: options.pluginSandbox ?? false,
    registrations: {
      command(name, handler, description) {
        if (typeof handler !== "function") throw new Error(`Plugin command "${name}" must be a function.`);
        if (name !== name.toLowerCase()) throw new Error(`Plugin command "${name}" must be lowercase.`);
        if ((MVP_COMMANDS as readonly string[]).includes(name) || name === "ide" || pluginCommands.has(name)) {
          throw new Error(`Plugin command "${name}" conflicts with a built-in or registered command.`);
        }
        const desc = typeof description === "string" && description.trim().length > 0 ? description.trim() : undefined;
        pluginCommands.set(name, desc === undefined ? { handler } : { handler, description: desc });
        return () => { if (pluginCommands.get(name)?.handler === handler) pluginCommands.delete(name); };
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
  const evolveService = createEvolveService({
    workspace,
    hooks,
    pluginHost,
    config: config.evolve,
    logger: {
      warn: (warning) => emitOutput({ type: "notice", message: `[evolve] ${warning}` }),
      notice: (message) => emitOutput({ type: "notice", message: `[evolve] ${message}` }),
    },
  });
  tools.push(evolveService.toolDefinition());
  let sleepScheduler: ProjectSleepScheduler | undefined;
  let collaborationClient: PalClientLike | undefined;
  let collaborationUnavailableDiagnostic: string | undefined;
  let unsubscribeCollaboration: (() => void) | undefined;
  let collaborationSession: FlavorSession | undefined;
  let deliverCollaborationEvent: ((event: BrokerEvent) => Promise<void>) | undefined;
  let latestCoWorkId: string | undefined;
  const pendingCollaborationEvents: BrokerEvent[] = [];
  let collaborationEventPump: Promise<void> | undefined;
  let collaborationEventsOpen = true;
  let islandControlServer: IslandControlServer | undefined;
  const pumpCollaborationEvents = (): void => {
    if (collaborationEventPump !== undefined || collaborationSession === undefined || deliverCollaborationEvent === undefined) return;
    collaborationEventPump = (async () => {
      while (pendingCollaborationEvents.length > 0) {
        const event = pendingCollaborationEvents.shift()!;
        try { await deliverCollaborationEvent!(event); }
        catch (error) { diagnostics.push(`Pal event failed: ${message(error)}`); }
      }
    })().finally(() => {
      collaborationEventPump = undefined;
      if (collaborationEventsOpen && pendingCollaborationEvents.length > 0) pumpCollaborationEvents();
    });
  };
  const enqueueCollaborationEvent = (event: BrokerEvent): void => {
    if (!collaborationEventsOpen) return;
    if (pendingCollaborationEvents.length >= 256) {
      diagnostics.push("Pal event queue is full; newest event was rejected");
      return;
    }
    pendingCollaborationEvents.push(event);
    pumpCollaborationEvents();
  };
  try {
  if (options.collaboration !== undefined) {
    const collaboration = options.collaboration;
    const defaultAlias = `${basename(workspace) || "flavor"}-${collaboration.instanceId.slice(0, 8)}`.slice(0, 64);
    const alias = PalAliasSchema.parse(collaboration.alias?.trim() || defaultAlias);
    const address = palSocketAddress({
      platform: process.platform,
      userScope: home,
      runtimeDir: join(tmpdir(), `flavor-code-pals-${createHash("sha256").update(home).digest("hex").slice(0, 16)}`),
    });
    const baseCollaborationClient = collaboration.client ?? collaboration.createClient?.({
      instanceId: collaboration.instanceId, alias, projectPath: workspace,
    }) ?? new PalClient({
      address,
      authHome: home,
      registration: { id: collaboration.instanceId, alias, projectPath: workspace },
      startBroker: () => ensurePalBrokerRunning({ address, ...(collaboration.startBroker === undefined ? {} : { startBroker: () => collaboration.startBroker!(address) }) }),
    });
    collaborationClient = collaboration.optional ? recoverablePalClient(baseCollaborationClient, () => {
      if (collaborationUnavailableDiagnostic === undefined) return;
      remove(diagnostics, collaborationUnavailableDiagnostic);
      collaborationUnavailableDiagnostic = undefined;
    }) : baseCollaborationClient;
    deliverCollaborationEvent = async (event: BrokerEvent): Promise<void> => {
      const session = collaborationSession;
      const client = collaborationClient;
      if (session === undefined || client === undefined) return;
      const senderId = event.type === "cowork-event" ? event.actorId
        : event.type === "chat-event" || event.type === "task-event" ? event.senderId : undefined;
      if (senderId === undefined) return;
      let senderAlias = senderId.slice(0, 8);
      try {
        senderAlias = (await client.list()).find(({ id }) => id === senderId)?.alias ?? senderAlias;
      } catch { /* Disconnected senders retain a safe short UUID fallback. */ }
      if (event.type === "task-event") {
        if (event.status !== "accepted" || event.detail === undefined) return;
        session.receivePalTask({
          senderId, senderAlias, messageId: event.messageId, taskId: event.taskId, goal: event.detail,
        });
        return;
      }
      if (event.type === "chat-event") {
        session.receivePalTask({
          senderId, senderAlias, messageId: event.messageId, taskId: event.messageId, goal: event.message,
        });
        return;
      }
      if (event.type === "cowork-event") {
        latestCoWorkId = event.coWorkId;
        if (event.action === "PROPOSE"
          && event.snapshot.participants.some(({ palId, required }) => palId === collaboration.instanceId && required)
          && !event.snapshot.acceptedParticipantIds.includes(collaboration.instanceId)) {
          await client.coWorkAction({ type: "cowork-accept", coWorkId: event.coWorkId, epoch: event.epoch });
        }
        const deliveryBase = {
          senderId, senderAlias, localId: collaboration.instanceId,
          coWorkId: event.coWorkId, epoch: event.epoch, snapshot: event.snapshot,
        };
        if (event.action === "START") {
          if (event.planHash === null) return;
          await session.receivePalCoWorkEvent({ ...deliveryBase, action: "START", planHash: event.planHash });
        } else {
          await session.receivePalCoWorkEvent({ ...deliveryBase, action: event.action, planHash: event.planHash });
        }
      }
    };
    unsubscribeCollaboration = collaborationClient.subscribe(enqueueCollaborationEvent);
    try { await collaborationClient.start(); }
    catch (error) {
      if (!collaboration.optional) throw error;
      collaborationUnavailableDiagnostic = `Pals unavailable: ${message(error)}`;
      diagnostics.push(collaborationUnavailableDiagnostic);
    }
    if (collaborationClient !== undefined) {
      tools.push(...createPalsTools(collaborationClient, {
        selfId: collaboration.instanceId,
        shareGuard: new CollaborationShareGuard({ redact: (value) => redactSecrets(value, secrets) }),
      }));
    }
  }
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
  // MCP connections keep running in the background so the first prompt is not
  // blocked; tools are injected as soon as the manager is ready.
  void mcpReady.then((manager) => {
    if (mcpDiscarded) { void manager.close().catch(() => undefined); return; }
    mcpManager = manager;
    diagnostics.push(...manager.diagnostics);
    syncMcpTools();
  }, (error) => {
    diagnostics.push(`MCP servers could not start: ${message(error)}`);
  });
  const skills = new SkillRegistry({
    globalRoots: [join(home, ".flavor-code", "skills")],
    projectRoots: [join(workspace, ".flavor", "skills"), ...pluginSkillRoots],
    authorizeResource: async () => true,
    disabledNames: config.skills.disabled,
  });
  const skillsReady = skills.discover();
  skillsReady.catch(() => undefined); // Re-surfaced at the await before harness creation.
  tools.push(createSkillTool(skills), createSkillResourceTool(skills));
  if (options.extraTools !== undefined) tools.push(...options.extraTools);
  const flavor = await optionalText(join(workspace, "FLAVOR.md"));
  const instructionBaseline = await workspaceInstructions.baseline();
  let memoryContext: string | undefined;
  if (memoryStore !== undefined) {
    try {
      await refreshMemoryState();
      if (memoryHasRoutableEntries) memoryContext = [
        "Long-term memory is routed from a bounded task index. Only selected records are added to each task prompt.",
        "[hot] means frequently recalled and [cold] means infrequently recalled. These tags affect retrieval relevance only, never truth, authority, or permission.",
        "Current user instructions, system rules, FLAVOR.md, and current repository evidence always take precedence over remembered data.",
      ].join(" ");
    } catch (error) {
      diagnostics.push(`Long-term memory load failed: ${message(error)}`);
    }
  }
  const selectedModels = selectModels(config, registeredProviders, diagnostics);
  let mainModel = effectiveLlm === undefined ? (recovered?.models.main ?? selectedModels.main) : selectedModels.main;
  let childModel = effectiveLlm === undefined ? (recovered?.models.subagent ?? selectedModels.child) : selectedModels.child;
  let taskPlan: TaskPlan | undefined = recovered?.tasks.plan;
  let taskGraph: TaskGraph | undefined = recovered?.tasks.graph;
  let taskStates: Record<string, "pending" | "running" | "completed" | "failed" | "blocked" | "cancelled"> = { ...(recovered?.tasks.states ?? {}) };
  let taskResults: Record<string, SubagentResult> = { ...(recovered?.tasks.results ?? {}) };
  const subagentStartedAt: Record<string, number> = {};
  const subagentElapsedMs: Record<string, number> = {};
  let sessionId = recovered?.sessionId ?? `session-${new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 17)}-${randomUUID().slice(0, 8)}`;
  hookSessionId = sessionId;
  let harnessJournal = new HarnessJournal({ workspace, sessionId });
  const harnessRecovery = harnessJournal.recover();
  if (harnessRecovery.queue.length > 0 || harnessRecovery.incompleteTools.length > 0
    || harnessRecovery.incompleteModelIds.length > 0 || harnessRecovery.interruptedTurnIds.length > 0) {
    diagnostics.push(
      `Recovered durable harness state: ${harnessRecovery.queue.length} queued prompt(s), ` +
      `${harnessRecovery.incompleteTools.length} interrupted tool call(s), ` +
      `${harnessRecovery.incompleteModelIds.length} interrupted model call(s), ${harnessRecovery.interruptedTurnIds.length} interrupted turn(s).`,
    );
    for (const tool of harnessRecovery.incompleteTools.filter((item) => !item.retrySafe)) {
      diagnostics.push(`Interrupted non-retry-safe tool "${tool.tool}" was not replayed (${tool.inputHash.slice(0, 12)}).`);
    }
    harnessJournal.markRecoveryComplete(harnessRecovery);
  }
  // Tag usage.jsonl with this session; the file is overwritten per session.
  setUsageSession(sessionId);
  ideSessionId = sessionId;
  await ideReady;
  await ide.startSession(sessionId);
  let createdAt = recovered?.createdAt ?? new Date().toISOString();
  let memoryLifecycle: NonNullable<SessionDocument["memory"]> = recovered?.memory
    ?? { status: "active", taskId: createMemoryTaskId(), messageStart: 0 };
  if (memoryLifecycle.taskId === undefined || memoryLifecycle.messageStart === undefined) {
    memoryLifecycle = {
      ...memoryLifecycle,
      ...(memoryLifecycle.taskId === undefined ? { taskId: createMemoryTaskId() } : {}),
      ...(memoryLifecycle.messageStart === undefined ? { messageStart: 0 } : {}),
    };
  }
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
    // Persist the resolved decision, not the harness snapshot: after logout the
    // harness may still hold the old login model, and resuming from that stale
    // value is what made the welcome card show a previous service.
    models: { main: mainModel, subagent: childModel }, permissionMode: harness.permissionMode,
    memory: memoryLifecycle,
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
    const snapshot = taskSnapshot();
    emitOutput({ type: "tasks", snapshot });
    await hooks.emit({
      version: 1,
      type: "Notification",
      payload: { kind: "task_snapshot", taskSnapshot: snapshot },
    }).catch(() => undefined);
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
    description: "Validate a task graph and execute its nodes with isolated child agents. " +
      "Declare each node's `files` (the workspace files it may create or modify) whenever a task writes files; " +
      "nodes with overlapping files are serialized automatically to prevent concurrent write conflicts.",
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
    isGitRepository: await gitRepository,
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
      system: () => {
        const sections = buildSystemPrompt({
          agent,
          languageInstruction: languageInstruction(language),
          workspace,
          toolNames: new Set(agentTools.map((tool) => tool.name)),
          environment: promptEnvironment,
        });
        const evolveSection = evolveService.promptSection();
        if (evolveSection !== undefined) sections.push(evolveSection);
        return sections;
      },
      volatileSystem: () => [
        buildCurrentDateSection(promptEnvironment.date),
        buildRuntimeEnvironmentSection({
          model: agent === "main" && harnessCreated ? harness.mainModelId : contextModelId,
          permissionMode: agent === "subagent"
            ? ((harnessCreated ? harness.permissionMode : (recovered?.permissionMode ?? config.permissionMode)) === "plan" ? "plan" : "bubble")
            : (harnessCreated ? harness.permissionMode : (recovered?.permissionMode ?? config.permissionMode)),
        }),
      ],
      ...(flavor === undefined ? {} : { flavor }),
      ...(instructionBaseline === "" ? {} : { workspaceInstructions: instructionBaseline }),
      ...(memoryContext === undefined ? {} : { memory: memoryContext }),
      ...(taskState === undefined ? {} : { taskState }),
      userMemory: () => userMemoryContext ?? "",
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
  await skillsReady;
  harness = new LocalHarness({
    registry, hooks, workspace, mainModelId: mainModel, subagentModelId: childModel,
    hallucinationGuard,
    tools, createContext, permissionMode: recovered?.permissionMode ?? config.permissionMode,
    permissionPolicy,
    maxIterationsMain: config.maxIterations.main,
    maxIterationsSubagent: config.maxIterations.subagent,
    hasActiveProgress,
    afterToolSuccess: async (_tool, paths, _input, _output, context) => workspaceInstructions.discover(paths, context.ownerId ?? context.agent),
    toolJournal: {
      start: (tool, input, retrySafe) => harnessJournal.startTool(tool, input, retrySafe),
      complete: (id, result) => harnessJournal.completeTool(id, result),
      interrupt: (id, reason) => harnessJournal.interruptTool(id, reason),
    },
    modelJournal: {
      start: (input) => harnessJournal.startModel(input),
      complete: (id, completed, error) => harnessJournal.completeModel(id, completed, error),
    },
    approve: resolveToolApproval,
  });
  harnessCreated = true;
  if (recovered !== undefined) harness.main.context.restore({
    ...(recovered.conversation.compact === undefined ? {} : { compact: recovered.conversation.compact }),
    ...(recovered.conversation.epoch === undefined ? {} : { epoch: {
      ...recovered.conversation.epoch,
      stableMessages: recovered.conversation.epoch.stableMessages.map((message) => ({
        role: "system" as const,
        content: message.content,
        ...(message.cacheBreakpoint === undefined ? {} : { cacheBreakpoint: message.cacheBreakpoint }),
      })),
    } }),
    ...(recovered.conversation.visibilityLog === undefined ? {} : {
      visibilityLog: recovered.conversation.visibilityLog,
    }),
    messages: recovered.conversation.messages.map((message): ModelMessage => {
      const metadata = {
        ...(message.toolCallId === undefined ? {} : { toolCallId: message.toolCallId }),
        ...(message.toolCalls === undefined ? {} : { toolCalls: message.toolCalls }),
      };
      if (message.role === "user") return { role: "user", content: message.content, ...metadata };
      return { role: message.role, content: message.content, ...metadata };
    }),
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
  const memoryCoordinator = memoryStore !== undefined
    ? new MemoryCoordinator({
      review: (taskId, candidates) => { memoryReviews.offer(taskId, candidates); },
      remember: async (taskId, candidates) => {
        let stored = 0;
        for (const candidate of candidates) {
          const result = await memoryStore.rememberForTask(taskId, candidate);
          if (result.added) {
            stored += 1;
            autoStoredContents.push(candidate.content);
          }
        }
        if (stored > 0) await refreshMemoryState();
        return stored;
      },
      minChars: config.memory.autoExtractMinChars,
      maxEntryChars: config.memory.maxEntryChars,
      scoreThreshold: config.memory.scoreThreshold,
      autoStoreThreshold: config.memory.autoStoreThreshold,
      maxCandidates: Math.min(config.memory.maxCandidatesPerTask, 1),
      ...(config.language === undefined ? {} : { language: config.language }),
      generate: (prompt, signal) => generateMemoryExtraction(registry, childModel, prompt, signal),
    })
    : undefined;
  if (memoryCoordinator !== undefined) {
    memoryCoordinator.onError = (error) => diagnostics.push(`Long-term memory extraction failed: ${message(error)}`);
  }
  const finalizeMemoryTask = async (manual = false): Promise<string> => {
    const allMessages = harness.main.context.snapshot().messages;
    const messages = allMessages.slice(memoryLifecycle.messageStart ?? 0);
    const transcriptHash = memoryTranscriptHash(messages);
    if (memoryLifecycle.status === "completed" && memoryLifecycle.transcriptHash === transcriptHash) {
      return "This conversation segment was already evaluated for long-term memory.";
    }
    if (!manual && memoryBehavior.autoExtractPaused) {
      return "Automatic long-term-memory extraction is paused after repeated dismissals; use /finish, /remember, or an explicit “remember” request to store memory manually.";
    }
    autoStoredContents.length = 0;
    const finalization = memoryCoordinator === undefined || !config.memory.autoExtract || options.approvalPolicy === "deny"
      ? { evaluated: true, candidates: false, stored: 0 }
      : await memoryCoordinator.finalize(memoryLifecycle.taskId ?? sessionId, messages);
    if (!finalization.evaluated) {
      return "Long-term-memory evaluation failed; retry /finish after checking diagnostics.";
    }
    memoryLifecycle = {
      status: "completed", taskId: memoryLifecycle.taskId ?? sessionId,
      messageStart: memoryLifecycle.messageStart ?? 0, finalizedAt: new Date().toISOString(), transcriptHash,
    };
    await persist();
    if (finalization.candidates && finalization.stored > 0) {
      const storedText = autoStoredContents[0] ?? "a high-confidence memory";
      return `Long-term memory updated. Stored high-confidence entry: "${storedText}". Run /forget to remove it if undesired.`;
    }
    return finalization.candidates
      ? "Long-term-memory evaluation completed. Review the generated candidates before anything is stored."
      : "Long-term-memory evaluation completed; no durable candidates passed the threshold.";
  };
  let explicitMemoryRequest: { taskId: string; messageStart: number } | undefined;
  let automaticMemoryTask = false;
  let interruptedTaskPlanNeedsReassessment = false;
  hooks.on("UserPromptSubmit", (event) => {
    const prompt = String(event.payload.prompt);
    const reassessInterruptedPlan = interruptedTaskPlanNeedsReassessment && !prompt.startsWith("/");
    timelineState = transcriptReducer(timelineState, { type: "submit", prompt });
    // D2C/E2E prompts are internal artifact-generation jobs. Their often-large PRD and
    // prototype transcripts are already persisted with the task and must not hold the
    // foreground submission open for automatic long-term-memory extraction.
    automaticMemoryTask = !prompt.startsWith("/") && harness.permissionProfile !== "d2c";
    if (automaticMemoryTask) memoryReviews.dismissAll();
    if (!prompt.startsWith("/")) {
      memoryLifecycle = {
        status: "active",
        taskId: memoryLifecycle.status === "completed"
          ? createMemoryTaskId()
          : memoryLifecycle.taskId ?? createMemoryTaskId(),
        messageStart: harness.main.context.snapshot().messages.length,
      };
    }
    if (isExplicitMemoryIntent(prompt)) {
      explicitMemoryRequest = {
        taskId: memoryLifecycle.taskId ?? sessionId,
        messageStart: harness.main.context.snapshot().messages.length,
      };
    }
    return {
      decision: "allow",
      ...(reassessInterruptedPlan ? { additionalContext: INTERRUPTED_TASK_PLAN_CONTEXT } : {}),
    };
  });
  hooks.on("Stop", async (event) => {
    timelineState = transcriptReducer(timelineState, { type: "finish" });
    const explicit = explicitMemoryRequest;
    const automatic = automaticMemoryTask;
    explicitMemoryRequest = undefined;
    automaticMemoryTask = false;
    if (explicit !== undefined && memoryCoordinator !== undefined) {
      const result = await memoryCoordinator.rememberExplicit(
        explicit.taskId, harness.main.context.snapshot().messages.slice(explicit.messageStart),
      );
      if (!result.evaluated) {
        emitOutput({ type: "notice", message: "Explicit long-term-memory request could not be analyzed; nothing was stored." });
      } else if (result.stored > 0) {
        if (memoryBehavior.autoExtractPaused || memoryBehavior.ignoreStreak > 0) {
          memoryBehavior = { ignoreStreak: 0, autoExtractPaused: false };
          void memoryStore?.saveBehavior(memoryBehavior).catch(() => undefined);
        }
        emitOutput({ type: "notice", message: `Stored ${result.stored} explicit long-term-memory ${result.stored === 1 ? "entry" : "entries"}.` });
      } else if (result.candidates) {
        emitOutput({ type: "notice", message: "The explicit memory already exists or the memory limit was reached." });
      } else {
        emitOutput({ type: "notice", message: "The explicit request did not contain durable information that passed the memory safety threshold." });
      }
    }
    if (explicit === undefined && automatic && event.payload.outcome === "completed"
      && memoryCoordinator !== undefined && config.memory.autoExtract && options.approvalPolicy !== "deny"
      && !memoryBehavior.autoExtractPaused) {
      const result = await finalizeMemoryTask();
      if (result.startsWith("Long-term-memory evaluation failed")) {
        emitOutput({ type: "notice", message: "Automatic long-term-memory evaluation failed; use /finish to retry after checking diagnostics." });
      } else if (result.startsWith("Long-term-memory evaluation completed. Review")
        || result.startsWith("Long-term memory updated.")) {
        emitOutput({ type: "notice", message: result });
      }
    }
    if (event.payload.outcome === "cancelled" && (taskPlan !== undefined || taskGraph !== undefined)) {
      interruptedTaskPlanNeedsReassessment = true;
    }
    taskPlan = undefined;
    taskGraph = undefined;
    taskStates = {};
    taskResults = {};
    for (const key of Object.keys(subagentStartedAt)) delete subagentStartedAt[key];
    for (const key of Object.keys(subagentElapsedMs)) delete subagentElapsedMs[key];
    harness.main.context.updateTaskState(undefined);
    emitOutput({ type: "tasks-cleared" });
    await persist();
    return { decision: "allow" };
  }, {
    // This handler awaits long-term-memory model calls; the 10s default timeout
    // would abort them mid-flight and surface a TimeoutError through the Stop hook.
    timeoutMs: 300_000,
    failurePolicy: "allow",
  });
  hooks.on("SessionEnd", async () => {
    await memoryCoordinator?.flush();
    await persist();
    return { decision: "allow" };
  }, { timeoutMs: 300_000, failurePolicy: "allow" });
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
    const loopExecutionEnvironment = createExecutionEnvironment(input.workspace, config.execution);
    const loopObservations = new FileObservationStore();
    const loopInstructions = new WorkspaceInstructions(input.workspace);
    const loopMutationOptions = { observations: loopObservations };
    const loopTools: ToolDefinition<unknown>[] = [
      createReadTool(input.workspace, { observations: loopObservations }), createWriteTool(input.workspace, loopMutationOptions), createEditTool(input.workspace, loopMutationOptions),
      createApplyPatchTool(input.workspace, loopMutationOptions), createGlobTool(input.workspace), createGrepTool(input.workspace),
      createShellTool(input.workspace, {
        jobs,
        ...(loopExecutionEnvironment === undefined ? {} : { executionEnvironment: loopExecutionEnvironment }),
      }),
      createWebFetchTool(), createWebSearchTool(), ...createJobTools(jobs),
      ...createLspTools(input.workspace, {
        onStatus: (status) => emitOutput({ type: "notice", message: status }),
      }),
      createTodoWriteTool(),
      evolveService.toolDefinition(),
      ...mcpTools,
    ];
    const loopFlavor = await optionalText(join(input.workspace, "FLAVOR.md"));
    const loopInstructionBaseline = await loopInstructions.baseline();
    const loopEnvironment = createPromptEnvironment({
      now: new Date(), platform: process.platform, osVersion: `${osVersion()} ${osRelease()}`,
      shell: environment.ComSpec ?? environment.SHELL ?? "unknown",
      isGitRepository: await detectGitRepository(input.workspace),
    });
    let compactionInputTokens = 0;
    let compactionOutputTokens = 0;
    let loopHarness!: LocalHarness;
    let loopHarnessCreated = false;
    const createLoopContext = (
      agent: "main" | "subagent", agentTools: readonly ToolDefinition<unknown>[], contextModelId: string,
    ) => {
      const language = resolveLanguage(config.language);
      const { compactAtChars, toolOutputChars, ...compaction } = config.context;
      return new ContextManager({
        system: () => {
          const sections = buildSystemPrompt({
            agent,
            languageInstruction: languageInstruction(language),
            workspace: input.workspace,
            toolNames: new Set(agentTools.map((tool) => tool.name)),
            environment: loopEnvironment,
          });
          const evolveSection = evolveService.promptSection();
          if (evolveSection !== undefined) sections.push(evolveSection);
          return sections;
        },
        volatileSystem: () => [
          buildCurrentDateSection(loopEnvironment.date),
          buildRuntimeEnvironmentSection({
            model: agent === "main" && loopHarnessCreated ? loopHarness.mainModelId : contextModelId,
            permissionMode: agent === "subagent"
              ? ((loopHarnessCreated ? loopHarness.permissionMode : harness.permissionMode) === "plan" ? "plan" : "bubble")
              : (loopHarnessCreated ? loopHarness.permissionMode : harness.permissionMode),
          }),
        ],
        ...(loopFlavor === undefined ? {} : { flavor: loopFlavor }),
        ...(loopInstructionBaseline === "" ? {} : { workspaceInstructions: loopInstructionBaseline }),
        ...(memoryContext === undefined ? {} : { memory: memoryContext }),
        userMemory: () => userMemoryContext ?? "",
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
      permissionPolicy,
      maxIterationsMain: config.maxIterations.main,
      maxIterationsSubagent: config.maxIterations.subagent,
      loopMode: true,
      afterToolSuccess: async (_tool, paths, _input, _output, context) => loopInstructions.discover(paths, context.ownerId ?? context.agent),
      toolJournal: {
        start: (tool, input, retrySafe) => harnessJournal.startTool(tool, input, retrySafe),
        complete: (id, result) => harnessJournal.completeTool(id, result),
        interrupt: (id, reason) => harnessJournal.interruptTool(id, reason),
      },
      modelJournal: {
        start: (input) => harnessJournal.startModel(input),
        complete: (id, completed, error) => harnessJournal.completeModel(id, completed, error),
      },
      approve: resolveToolApproval,
    });
    loopHarnessCreated = true;
    let runReason = "finished";
    try {
      evolveService.beginRun();
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
    } catch (error) {
      runReason = input.signal.aborted ? "cancelled" : "error";
      throw error;
    } finally {
      await evolveService.endRun(runReason);
      loopHarness.dispose();
      await loopExecutionEnvironment?.dispose();
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
    runVerifier: async (plan, executionWorkspace, signal) => {
      const verifierEnvironment = createExecutionEnvironment(executionWorkspace, config.execution);
      try {
        return await runVerificationPlan(plan, executionWorkspace, signal, verifierEnvironment);
      } finally {
        await verifierEnvironment?.dispose();
      }
    },
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
  const goalStore = new GoalStore({ workspace });
  const goalOrchestrator = new GoalOrchestrator({
    workspace,
    registry,
    plannerModelId: mainModel,
    classifierModelId: mainModel,
    skepticCount: 3,
    maxRounds: 5,
    maxStallStreak: 2,
    persistence: goalStore,
    verifyHost: async (signal) => runVerificationPlan(
      await inferVerificationPlan(workspace), workspace, signal, executionEnvironment,
    ),
    now: () => new Date().toISOString(),
    idFactory: () => `goal-${new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 17)}-${randomUUID().slice(0, 8)}`,
    runWorker: ({ workspace: goalWorkspace, prompt, signal }) =>
      runLoopWorker({ workspace: goalWorkspace, prompt, signal }),
  });

  let sessionHistory = await SessionHistory.open({
    workspace,
    sessionId,
    restoreContext: (snapshot) => harness.main.context.restore(snapshot),
  });

  const collaborationId = options.collaboration?.instanceId;
  const resolveCollaborationTarget = async (target: string): Promise<PalPresence> => {
    const pals = await collaborationClient!.list();
    const parsedTarget = PalTargetSchema.safeParse(target);
    if (!parsedTarget.success) throw new Error("Invalid pal target");
    const normalized = normalizePalIdentity(parsedTarget.data);
    const exact = pals.find((pal) => pal.id.toLowerCase() === normalized || normalizePalIdentity(pal.alias) === normalized);
    if (exact !== undefined) return exact;
    const prefixed = normalized.length < MIN_UUID_PREFIX_LENGTH
      ? []
      : pals.filter((pal) => pal.id.toLowerCase().startsWith(normalized));
    if (prefixed.length === 1) return prefixed[0]!;
    throw new Error(prefixed.length > 1 ? `Pal target '${target}' is ambiguous` : `Pal '${target}' is not active`);
  };
  const palServices: SessionServices["pals"] = collaborationClient === undefined || collaborationId === undefined ? undefined : {
    list: async (verbose) => (await collaborationClient!.list()).map((presence) => verbose ? {
      id: presence.id, alias: presence.alias, projectPath: presence.projectPath,
      connectedAt: presence.connectedAt, lastSeenAt: presence.lastSeenAt,
    } : {
      id: presence.id, alias: presence.alias,
      connectedAt: presence.connectedAt, lastSeenAt: presence.lastSeenAt,
    }),
    rename: (alias) => collaborationClient!.rename(alias),
    info: (target) => resolveCollaborationTarget(target),
    sendChat: (target, message) => collaborationClient!.sendChat(target, message),
    sendTask: (target, goal) => collaborationClient!.sendTask(target, goal),
    startCoWork: async (target, goal) => {
      const recipient = await resolveCollaborationTarget(target);
      if (recipient.id.toLowerCase() === collaborationId.toLowerCase()) {
        throw new Error("A co-work target cannot be the local instance itself");
      }
      const snapshot = await collaborationClient!.startCoWork({
        goal,
        participants: [{ palId: collaborationId, required: true }, { palId: recipient.id, required: true }],
      });
      latestCoWorkId = snapshot.coWorkId;
      return snapshot;
    },
    coWorkStatus: (coWorkId) => {
      const selected = coWorkId ?? latestCoWorkId;
      if (selected === undefined) throw new Error("No co-work has been selected");
      return collaborationClient!.coWorkStatus(selected);
    },
    cancelCoWork: (coWorkId, reason) => collaborationClient!.cancelCoWork(
      coWorkId, reason?.trim() || "cancelled by local user",
    ),
  };

  const services: SessionServices = {
    hooks, workspace,
    durableQueue: {
      recover: () => harnessRecovery.queue,
      admit: (kind, payload) => harnessJournal.admitQueue(kind, payload),
      claim: (id) => harnessJournal.claimQueue(id),
      ack: (id) => harnessJournal.ackQueue(id),
      release: (id, reason) => harnessJournal.releaseQueue(id, reason),
    },
    mainModel: () => mainModel,
    subagentModel: () => childModel,
    llmServiceName: () => effectiveLlm?.serviceName,
    permissionMode: () => harness.permissionMode,
    addContext: (content) => {
      const duplicate = harness.main.context.snapshot().messages.some((entry) => entry.role === "system" && entry.content === content);
      if (!duplicate) harness.main.context.append({ role: "system", content });
    },
    ...(palServices === undefined ? {} : { pals: palServices }),
    run: (prompt, signal, runOptions) => {
      interruptedTaskPlanNeedsReassessment = false;
      const turnConfig = Object.freeze({
        mainModel,
        subagentModel: childModel,
        permissionMode: harness.permissionMode,
        contextEpoch: harness.main.context.snapshot().epoch?.id ?? "legacy",
      });
      const turnId = harnessJournal.startTurn(turnConfig, { prompt, initialUserMessage: runOptions?.initialUserMessage });
      return durableTurn(persistAndCheckpointAfter(runMain(
        harness, skills, prompt, signal, selectedModels.mainError,
        memoryStore === undefined || (!memoryHasRoutableEntries && userMemoryContext === undefined) ? undefined : {
          store: memoryStore, taskId: memoryLifecycle.taskId ?? sessionId,
          topK: config.memory.retrievalTopK, maxChars: config.memory.maxPromptChars,
        },
        runOptions?.getSteeringMessages,
        runOptions?.initialUserMessage,
        runOptions?.additionalContext,
        ide,
      ), persist, () => sessionHistory.append({
        prompt,
        context: harness.main.context.snapshot(),
        label: `turn: ${prompt.slice(0, 80)}`,
      })), harnessJournal, turnId, turnConfig);
    },
    runSkill: (skill, prompt, signal) => persistAfter(
      runExplicitSkill(harness, skills, skill, prompt, signal, selectedModels.mainError), persist,
    ),
    runLoop: (goal, signal) => runLoopSession(loopOrchestrator, hooks, goal, signal),
    runGoal: (goal, signal) => persistEach(runGoalSession(goalOrchestrator, goal, signal), persist),
    mcp: async (command, signal) => {
      signal.throwIfAborted();
      const manager = await mcpReady;
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
    setModel: async (role, id) => {
      if (effectiveLlm !== undefined) {
        const parsed = parseModelId(id);
        if (parsed.provider !== effectiveLlm.providerId || !effectiveLlm.models.includes(parsed.model)) {
          throw new Error(`Model "${id}" is not allowed by the current PKCE configuration.`);
        }
      }
      harness.setModel(role, id);
      if (role === "main") mainModel = id;
      else childModel = id;
      await persist();
    },
    setPermissionMode: async (mode) => { harness.setPermissionMode(mode); await persist(); },
    compact: async (signal) => { const changed = await harness.main.context.compact(signal); if (changed) await persist(); return changed; },
    initialize: () => initializeFlavor(workspace),
    config: () => ({
      ...config, sources: loaded.sources,
      ...(effectiveLlm === undefined ? {} : { effectiveLlm: publicEffectiveLlm(effectiveLlm) }),
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
    evolve: (args: readonly string[]) => evolveService.handleCommand(args),
    gitCommit: (hint, signal) => runGitCommit({
      workspace, registry, questions,
      modelId: () => harness.subagentModelId,
      notify: (message) => emitOutput({ type: "notice", message }),
    }, hint, signal),
    gitReview: (focus, signal) => runGitReview({
      workspace, registry,
      modelId: () => harness.subagentModelId,
      notify: (message) => emitOutput({ type: "notice", message }),
    }, focus, signal),
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
    usage: async () => {
      try {
        const raw = await readFile(usageLogPath(), "utf8");
        return formatUsageSummary(summarizeUsage(parseUsageEntries(raw)));
      } catch (error) {
        if (typeof error === "object" && error !== null && "code" in error && (error as Record<string, unknown>).code === "ENOENT") {
          return "No usage recorded in this session yet.";
        }
        return `Failed to read usage log: ${message(error)}`;
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
      taskPlan = undefined;
      taskGraph = undefined;
      taskStates = {};
      taskResults = {};
      for (const key of Object.keys(subagentStartedAt)) delete subagentStartedAt[key];
      for (const key of Object.keys(subagentElapsedMs)) delete subagentElapsedMs[key];
      const previousIdeSessionId = ideSessionId;
      sessionId = `session-${new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 17)}-${randomUUID().slice(0, 8)}`;
      hookSessionId = sessionId;
      harnessJournal = new HarnessJournal({ workspace, sessionId });
      setUsageSession(sessionId);
      ideSessionId = sessionId;
      if (previousIdeSessionId !== undefined) await ide.endSession(previousIdeSessionId);
      await ide.startSession(sessionId);
      createdAt = new Date().toISOString();
      sessionHistory = await SessionHistory.open({
        workspace,
        sessionId,
        restoreContext: (snapshot) => harness.main.context.restore(snapshot),
      });
      memoryLifecycle = { status: "active", taskId: createMemoryTaskId(), messageStart: 0 };
      timelineState = createTranscriptState();
      await persist();
      emitOutput({ type: "tasks", snapshot: { subagents: { states: {} } } });
    },
    ide: () => ide.status(),
    ideContext: () => ide.editorContext(),
    checkpoint: async (label) => {
      // Tag checkpoints with the git state so /tree shows what the workspace
      // looked like at each node.
      const marker = await gitMarker(workspace);
      const tagged = marker === undefined ? label : label === undefined ? `git: ${marker}` : `${label} (git: ${marker})`;
      return sessionHistory.checkpoint(tagged, harness.main.context.snapshot());
    },
    tree: () => sessionHistory.tree(),
    historyLeaf: () => sessionHistory.leafId,
    rewind: async (nodeId) => {
      await sessionHistory.rewind(nodeId, harness.main.context.snapshot());
      await persist();
    },
    unrevert: async () => {
      await sessionHistory.unrevert();
      await persist();
    },
    fork: async (nodeId) => {
      await sessionHistory.fork(nodeId);
      await persist();
    },
    memory: async () => {
      if (memoryStore === undefined) return "Long-term memory is disabled.";
      const entries = await memoryStore.list();
      return entries.length === 0
        ? `No long-term memories stored.\nPath: ${memoryStore.path}`
        : `Path: ${memoryStore.path}\n\n${renderMemoryDocument(entries)}`;
    },
    refreshMemory: refreshMemoryState,
    remember: async (type, text) => {
      if (memoryStore === undefined) return "Long-term memory is disabled.";
      const result = await memoryStore.remember({ type, content: text });
      if (result.added) await refreshMemoryState();
      return result.added
        ? `Remembered ${result.entry.type} memory ${result.entry.id}.`
        : `Memory already exists or the ${config.memory.maxEntries}-entry limit was reached.`;
    },
    forget: async (query) => {
      if (memoryStore === undefined) return "Long-term memory is disabled.";
      const removed = await memoryStore.forget(query);
      if (removed > 0) await refreshMemoryState();
      return removed === 0 ? "No matching memory found." : `Forgot ${removed} memory ${removed === 1 ? "entry" : "entries"}.`;
    },
    forgetCold: async () => {
      if (memoryStore === undefined) return "Long-term memory is disabled.";
      const { removed, filesRemoved } = await memoryStore.forgetCold();
      if (removed > 0) await refreshMemoryState();
      return removed === 0
        ? "No cold long-term memories to remove."
        : `Forgot ${removed} cold memory ${removed === 1 ? "entry" : "entries"} and removed ${filesRemoved} task ${filesRemoved === 1 ? "file" : "files"}.`;
    },
    finishTask: () => finalizeMemoryTask(true),
    pluginCommands: () => [...pluginCommands.entries()]
      .map(([name, entry]) => entry.description === undefined ? { name } : { name, description: entry.description })
      .sort((left, right) => left.name.localeCompare(right.name)),
    runPluginCommand: async (name, args, signal) => {
      const handler = pluginCommands.get(name)?.handler;
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
      const configuredMainModel = config.agents?.main?.model;
      if (configuredMainModel !== undefined) {
        const mainProvider = safeProvider(configuredMainModel);
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
        const credentialId = oauthCredentialId(oauthConfig.tokenUrl, oauthConfig.clientId);
        await migrateLegacyOAuthToken(tokenStore, providerName, credentialId);
        const oauth = new OAuthCallbackAuthProvider({
          authorizationUrl: oauthConfig.authorizationUrl,
          tokenUrl: oauthConfig.tokenUrl,
          clientId: oauthConfig.clientId,
          ...(oauthConfig.scope === undefined ? {} : { scope: oauthConfig.scope }),
          store: tokenStore,
        });
        const result = await oauth.resolve(credentialId, undefined, true);
        if (result.llmConfig === undefined) {
          return `Authenticated to "${providerName}". Token expires ${result.expiresAt ?? "unknown"}.`;
        }
        const next = effectiveRuntime(result, credentialId);
        const provider = providerFromOAuthConfig(next);
        const adapterOptions = {
          apiKey: next.accessToken,
          baseURL: next.baseURL,
          ...(next.maxOutputTokens === undefined ? {} : { maxOutputTokens: next.maxOutputTokens }),
        };
        registry.register(next.providerId, next.apiType === "anthropic"
          ? new AnthropicModelAdapter({
            ...adapterOptions,
            ...(providerConfig?.claudeClient === true ? { headers: CLAUDE_CLIENT_HEADERS } : {}),
          })
          : new OpenAIModelAdapter(adapterOptions));
        effectiveLlm = next;
        mainModel = `${next.providerId}:${next.defaultModel}`;
        childModel = `${next.providerId}:${next.cheapModel}`;
        harness.setModel("main", mainModel);
        harness.setModel("subagent", childModel);
        hallucinationGuard.setModel(childModel);
        goalOrchestrator.setModels(mainModel, mainModel);
        delete selectedModels.mainError;
        delete selectedModels.childError;
        // `/login` switches the active service: drop tokens from previous
        // logins so the next startup cannot surface a stale service name.
        await retainOnlyCredentials(tokenStore, credentialId);
        if (!secrets.includes(next.accessToken)) secrets.push(next.accessToken);
        await persist();
        return `Authenticated to "${next.serviceName}". Main model ${mainModel}; subagent ${childModel}; gateway ${next.baseURL}. Configuration is active now.`;
      } catch (error) {
        return `Login failed: ${message(error)}`;
      }
    },
    async logout() {
      const tokenStore = createFileTokenStore(join(home, ".flavor-code", "auth.json"));
      const tokens = await tokenStore.load();
      const hadCredentials = Object.keys(tokens).length > 0 || effectiveLlm !== undefined;
      if (!hadCredentials) {
        return "Not authenticated — no stored OAuth credentials to clear.";
      }

      // Drop OAuth-managed adapters and registrations, then clear the token file.
      for (let i = registeredProviders.length - 1; i >= 0; i -= 1) {
        const provider = registeredProviders[i];
        if (provider !== undefined && provider.pkceManaged === true) {
          registry.unregister(provider.name);
          registeredProviders.splice(i, 1);
        }
      }
      if (effectiveLlm !== undefined) {
        registry.unregister(effectiveLlm.providerId);
        effectiveLlm = undefined;
      }
      await tokenStore.save({});

      // Fall back to apiKey/env-configured providers.
      const fallback = selectModels(config, registeredProviders, diagnostics);
      mainModel = fallback.main;
      childModel = fallback.child;
      if (fallback.mainError === undefined) delete selectedModels.mainError;
      else selectedModels.mainError = fallback.mainError;
      if (fallback.childError === undefined) delete selectedModels.childError;
      else selectedModels.childError = fallback.childError;
      if (fallback.mainError === undefined
        && registry.has(safeProvider(mainModel))
        && registry.has(safeProvider(childModel))) {
        harness.setModel("main", mainModel);
        harness.setModel("subagent", childModel);
        hallucinationGuard.setModel(childModel);
        goalOrchestrator.setModels(mainModel, mainModel);
      }
      await persist();
      return fallback.mainError === undefined
        ? `Logged out. Cleared OAuth credentials. Main model ${mainModel}; subagent ${childModel}.`
        : `Logged out. Cleared OAuth credentials. ${fallback.mainError}`;
    },
  };
  if (config.sleep) {
    const sleepOrganizer = new ProjectSleepOrganizer({
      workspace,
      sessions: sessionStore,
      generate: (prompt, signal) => generateSleepReview(registry, childModel, prompt, signal),
    });
    sleepScheduler = new ProjectSleepScheduler({
      enabled: true,
      catchUpDates: () => sleepOrganizer.pendingDates(localDateKey(new Date())),
      organize: async (date, signal) => {
        await persist();
        return sleepOrganizer.organize(date, signal);
      },
      onError: (error) => {
        const diagnostic = `Sleep review failed: ${message(error)}`;
        diagnostics.push(diagnostic);
        emitOutput({ type: "notice", message: diagnostic });
      },
    });
    sleepScheduler.start();
  }
  const session = new FlavorSession(services);
  if (pluginHost.loadedPlugins.some((plugin) => plugin.name === "flavor-island")) {
    try {
      islandControlServer = await createIslandControlServer({
        sessionId,
        session,
        ...(options.islandControl?.focus === undefined ? {} : { focus: options.islandControl.focus }),
      });
      islandControlMetadata = {
        endpoint: islandControlServer.endpoint,
        token: islandControlServer.token,
        capabilities: islandControlServer.capabilities,
      };
    } catch (error) {
      diagnostics.push(`Flavor Island control channel unavailable: ${message(error)}`);
    }
  }
  collaborationSession = session;
  pumpCollaborationEvents();
  const authorization = {
    permissionProfile: () => harness.permissionProfile,
    setPermissionProfile: (profile: PermissionProfile) => harness.setPermissionProfile(profile),
  };
  let disposed = false;
  return {
    session, services, authorization, approvals, memoryReviews, restoredTranscript,
    jobs: { list: () => jobs.list(), read: (id, owner, cursor) => jobs.read(id, owner, cursor), subscribe: (listener) => jobs.subscribe(listener) },
    get sessionId() { return sessionId; },
    get diagnostics() { return diagnostics.map((item) => redactSecrets(item, secrets)); },
    async dispose() {
      if (disposed) return;
      disposed = true;
      const stepTimeoutMs = options.shutdownStepTimeoutMs ?? DEFAULT_SHUTDOWN_STEP_TIMEOUT_MS;
      collaborationEventsOpen = false;
      unsubscribeCollaboration?.();
      if (collaborationEventPump !== undefined) await boundedStep(stepTimeoutMs, diagnostics, "collaboration-event-pump", collaborationEventPump);
      mcpDiscarded = true;
      if (sleepScheduler !== undefined) await boundedStep(stepTimeoutMs, diagnostics, "sleep-scheduler", sleepScheduler.dispose());
      if (memoryCoordinator !== undefined) await boundedStep(stepTimeoutMs, diagnostics, "memory-flush", memoryCoordinator.flush());
      await boundedStep(stepTimeoutMs, diagnostics, "persist", persist());
      if (persistTail !== undefined) await boundedStep(stepTimeoutMs, diagnostics, "persist-tail", persistTail);
      if (ideSessionId !== undefined) await boundedStep(stepTimeoutMs, diagnostics, "ide-end-session", ide.endSession(ideSessionId));
      if (executionEnvironment !== undefined) await boundedStep(stepTimeoutMs, diagnostics, "execution-environment", executionEnvironment.dispose());
      if (islandControlServer !== undefined) await boundedStep(stepTimeoutMs, diagnostics, "island-control", islandControlServer.close());
      terminals.dispose();
      await boundedStep(stepTimeoutMs, diagnostics, "jobs", jobs.dispose());
      auditLogger.close();
      evolveService.dispose();
      memoryReviews.dispose();
      if (collaborationClient !== undefined) await boundedStep(stepTimeoutMs, diagnostics, "collaboration-close", collaborationClient.close());
      await cleanupProduction(approvals, questions, pluginHost, mcpManager, harness, { stepTimeoutMs });
    },
  };
  } catch (primaryError) {
    collaborationEventsOpen = false;
    mcpDiscarded = true;
    memoryReviews.dispose();
    await islandControlServer?.close().catch(() => undefined);
    try {
      const stepTimeoutMs = options.shutdownStepTimeoutMs ?? DEFAULT_SHUTDOWN_STEP_TIMEOUT_MS;
      if (ideSessionId !== undefined) await boundedStep(stepTimeoutMs, diagnostics, "ide-end-session", ide.endSession(ideSessionId));
      if (sleepScheduler !== undefined) await boundedStep(stepTimeoutMs, diagnostics, "sleep-scheduler", sleepScheduler.dispose());
      if (executionEnvironment !== undefined) await boundedStep(stepTimeoutMs, diagnostics, "execution-environment", executionEnvironment.dispose());
      terminals.dispose();
      await boundedStep(stepTimeoutMs, diagnostics, "jobs", jobs.dispose());
      unsubscribeCollaboration?.();
      pendingCollaborationEvents.length = 0;
      if (collaborationEventPump !== undefined) await boundedStep(stepTimeoutMs, diagnostics, "collaboration-event-pump", collaborationEventPump);
      if (collaborationClient !== undefined) await boundedStep(stepTimeoutMs, diagnostics, "collaboration-close", collaborationClient.close());
      await cleanupProduction(approvals, questions, pluginHost, mcpManager, harnessCreated ? harness : undefined, { stepTimeoutMs });
    }
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
  orchestrator: LoopOrchestrator, hooks: HookBus, goal: string, signal: AbortSignal,
): AsyncIterable<AgentEvent> {
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let latestVerification: LoopVerificationEvidence | undefined;
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
    if (event.type === "loop-verification") latestVerification = event.evidence;
    yield loopProgressEvent(event);
    if (event.type === "loop-terminal") {
      await hooks.emit({
        version: 1,
        type: "LoopEnd",
        payload: {
          loopId: event.loopId,
          outcome: event.status,
          reason: event.reason,
          verification: latestVerification ?? null,
        },
      }).catch(() => undefined);
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
  memory?: { store: MemoryStore; taskId: string; topK: number; maxChars: number },
  getSteeringMessages?: () => readonly string[],
  initialUserMessage?: Extract<ModelMessage, { role: "user" }>,
  promptContext?: string,
  ide?: FlavorIdeClient,
): AsyncIterable<AgentEvent> {
  const contexts: string[] = [];
  try {
    if (setupError !== undefined) {
      harness.main.context.append({ role: "user", content: prompt });
      yield { type: "error", error: { code: "unknown", message: setupError } };
      return;
    }
    if (promptContext !== undefined) contexts.push(promptContext);
    if (memory !== undefined) {
      try {
        const recalled = await memory.store.recall(prompt, {
          taskId: memory.taskId, topK: memory.topK, maxChars: memory.maxChars,
        });
        if (recalled.context !== undefined) contexts.push(recalled.context);
      } catch {
        // Memory routing is best effort and must never block the current task.
      }
    }
    const ideContext = await ide?.promptContext();
    if (ideContext !== undefined) contexts.push(ideContext);
    const skill = await skills.match(prompt);
    if (skill !== undefined) contexts.push(`Matched skill: ${skill.name}\n${expandSkillArguments(await skills.loadBody(skill), prompt)}`);
    const additionalContext = contexts.length === 0 ? undefined : contexts.join("\n\n");
    for await (const event of harness.main.loop.run({
      prompt,
      signal,
      ...(initialUserMessage === undefined ? {} : { initialUserMessage }),
      ...(additionalContext === undefined ? {} : { additionalContext }),
      ...(getSteeringMessages === undefined ? {} : { getSteeringMessages }),
    })) {
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
    const additionalContext = `Matched skill: ${skill.name}\n${expandSkillArguments(await skills.loadBody(skill), prompt)}`;
    yield* harness.main.loop.run({ prompt: userPrompt, signal, additionalContext });
  } catch (error) {
    yield { type: "error", error: { code: "unknown", message: message(error) } };
  }
}

async function* persistAfter<T>(source: AsyncIterable<T>, persist: () => Promise<void>): AsyncIterable<T> {
  try { for await (const item of source) yield item; }
  finally { await persist(); }
}

async function* persistAndCheckpointAfter<T>(
  source: AsyncIterable<T>,
  persist: () => Promise<void>,
  checkpoint: () => Promise<unknown>,
): AsyncIterable<T> {
  try {
    for await (const item of source) yield item;
    await checkpoint();
  } finally {
    await persist();
  }
}

async function* persistEach<T>(source: AsyncIterable<T>, persist: () => Promise<void>): AsyncIterable<T> {
  try {
    for await (const item of source) {
      yield item;
      await persist();
    }
  } finally {
    await persist();
  }
}

async function* durableTurn(
  source: AsyncIterable<AgentEvent>,
  journal: HarnessJournal,
  turnId: string,
  config: unknown,
): AsyncIterable<AgentEvent> {
  let failure: string | undefined;
  let completed = false;
  try {
    for await (const event of source) {
      if (event.type === "error") failure = event.error.message;
      yield event;
    }
    completed = true;
  } catch (error) {
    failure = message(error);
    throw error;
  } finally {
    if (completed && failure === undefined) {
      journal.completeTurn(turnId);
      journal.savepoint("turn-complete", config);
    } else {
      journal.interruptTurn(turnId, failure ?? "turn consumer interrupted before completion");
    }
  }
}

interface GitCommandDeps {
  workspace: string;
  registry: ModelRegistry;
  questions?: QuestionBridge;
  /** Cheap model id provider; evaluated lazily so /model switches apply. */
  modelId(): string;
  notify?(message: string): void;
}

async function runGitCommit(deps: GitCommandDeps, hint: string | undefined, signal: AbortSignal): Promise<string> {
  if (!(await isGitRepository(deps.workspace))) return "Not a git repository — /commit needs git.";
  let summary = await changeSummary(deps.workspace);
  if (summary.statusLines.length === 0) return "Working tree clean — nothing to commit.";
  if (summary.stagedFiles.length === 0) {
    if (deps.questions === undefined) throw new Error("Nothing is staged. Run `git add` on the files you want to commit first.");
    const stageAnswers = await deps.questions.ask([{
      header: "Staging",
      question: `Nothing is staged, but ${summary.statusLines.length} change(s) exist. Stage everything before committing?`,
      options: [
        { label: "Stage all", description: "Run git add -A, then generate the commit message." },
        { label: "Cancel", description: "Abort /commit and leave the working tree as-is." },
      ],
    }], signal);
    if (stageAnswers[0] !== "Stage all") return "/commit cancelled — nothing was staged.";
    await stageAll(deps.workspace);
    summary = await changeSummary(deps.workspace);
    if (summary.stagedFiles.length === 0) return "Nothing ended up staged — /commit aborted.";
  }
  const staged = await stagedDiff(deps.workspace);
  signal.throwIfAborted();
  deps.notify?.("Generating commit message…");
  let commitMessage: string;
  try {
    commitMessage = await suggestCommitMessage(
      { registry: deps.registry, modelId: deps.modelId },
      { stat: staged.stat, diff: staged.diff, ...(hint === undefined ? {} : { hint }) },
      signal,
    );
  } catch (error) {
    signal.throwIfAborted();
    const scope = summary.stagedFiles.length === 1 ? (summary.stagedFiles[0] ?? "1 file") : `${summary.stagedFiles.length} files`;
    commitMessage = `chore: update ${scope}`;
    deps.notify?.(`Commit message generation failed (${message(error)}); using a fallback message.`);
  }
  deps.notify?.(`Proposed commit message:\n${commitMessage}`);
  if (deps.questions !== undefined) {
    const confirmAnswers = await deps.questions.ask([{
      header: "Commit",
      question: `Commit ${summary.stagedFiles.length} staged file(s) on ${summary.branch} with the message above?`,
      options: [
        { label: "Commit", description: "Run git commit with the proposed message." },
        { label: "Cancel", description: "Abort; the staged changes stay as-is." },
      ],
    }], signal);
    if (confirmAnswers[0] !== "Commit") return "/commit cancelled — staged changes left untouched.";
  }
  const result = await gitCommitChange(deps.workspace, commitMessage);
  return `Committed: ${result}`;
}

async function runGitReview(deps: GitCommandDeps, focus: string | undefined, signal: AbortSignal): Promise<string> {
  if (!(await isGitRepository(deps.workspace))) return "Not a git repository — /review needs git.";
  const changes = await uncommittedDiff(deps.workspace);
  if (changes.diff.trim() === "" && changes.untracked.length === 0) return "No uncommitted changes to review.";
  signal.throwIfAborted();
  deps.notify?.("Reviewing uncommitted changes…");
  const report = await reviewDiff(
    { registry: deps.registry, modelId: deps.modelId },
    { stat: changes.stat, diff: changes.diff, untracked: changes.untracked, ...(focus === undefined ? {} : { focus }) },
    signal,
  );
  return formatReviewReport(report);
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
      ...(task.files === undefined || task.files.length === 0
        ? []
        : [`Owned files: ${task.files.join(", ")}. Restrict your file writes to these paths; concurrent tasks own everything else.`]),
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
): Promise<{ registered: RegisteredProvider[]; effectiveLlm?: EffectiveLlmRuntime }> {
  const configured = { ...providers };
  if (configured.openai === undefined && environment.OPENAI_API_KEY) configured.openai = { type: "openai", apiKey: environment.OPENAI_API_KEY };
  if (configured.anthropic === undefined && environment.ANTHROPIC_API_KEY) configured.anthropic = { type: "anthropic", apiKey: environment.ANTHROPIC_API_KEY };
  const oauthTokenStore = createFileTokenStore(join(home, ".flavor-code", "auth.json"));
  const registered: RegisteredProvider[] = [];
  let effectiveLlm: EffectiveLlmRuntime | undefined;
  for (const [name, provider] of Object.entries(configured)) {
    try {
      // Step 1: Determine the API protocol from provider type
      let apiProtocol: "openai" | "anthropic";
      let runtimeName = name;
      let runtimeProvider: ProviderRuntimeConfig = provider;
      let authResult: AuthResult | undefined;
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
          const credentialId = oauthCredentialId(oauthConfig.tokenUrl, oauthConfig.clientId);
          await migrateLegacyOAuthToken(oauthTokenStore, name, credentialId);
          const result = await oauth.resolve(credentialId);
          authResult = result;
          apiKey = result.headers.authorization?.replace(/^Bearer /, "") ?? "";
          if (result.llmConfig !== undefined) {
            apiProtocol = result.llmConfig.apiType;
            runtimeName = result.llmConfig.providerId;
            runtimeProvider = providerFromOAuthConfig(result.llmConfig);
            effectiveLlm ??= effectiveRuntime(result, credentialId);
          }
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
        ...(runtimeProvider.baseURL === undefined ? {} : { baseURL: runtimeProvider.baseURL }),
        ...(runtimeProvider.maxOutputTokens === undefined ? {} : { maxOutputTokens: runtimeProvider.maxOutputTokens }),
      };
      const adapter: ModelAdapter = apiProtocol === "anthropic"
        ? new AnthropicModelAdapter({
          ...adapterOptions,
          ...(runtimeProvider.claudeClient === true ? { headers: CLAUDE_CLIENT_HEADERS } : {}),
        })
        : new OpenAIModelAdapter(adapterOptions);

      // Step 4: Identify cache capability from apiType (flavor.json) and baseURL
      const cacheProfile = resolveCacheProfile({ apiType: apiProtocol, baseURL: runtimeProvider.baseURL });
      if (apiProtocol === "openai" && isDashScopeBaseURL(runtimeProvider.baseURL)) {
        diagnostics.push(
          `Provider "${runtimeName}" is a DashScope service called through the Responses API; DashScope Context Cache does not apply, so prompt cache hit ratio may stay low.`,
        );
      }

      registry.register(runtimeName, adapter);
      registered.push({
        name: runtimeName,
        sourceName: name,
        ...runtimeProvider,
        cacheStrategy: cacheProfile.strategy,
        ...(authResult?.llmConfig === undefined ? {} : { pkceManaged: true }),
      });
    } catch (error) { diagnostics.push(`Provider "${name}" could not start: ${message(error)}`); }
  }
  return { registered, ...(effectiveLlm === undefined ? {} : { effectiveLlm }) };
}

interface ProviderRuntimeConfig {
  type: string;
  apiKey?: string | undefined;
  baseURL?: string | undefined;
  defaultModel?: string | undefined;
  cheapModel?: string | undefined;
  maxOutputTokens?: number | undefined;
  models?: string[] | undefined;
  claudeClient?: boolean | undefined;
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
interface RegisteredProvider extends ProviderRuntimeConfig {
  name: string;
  sourceName?: string;
  pkceManaged?: boolean;
  cacheStrategy?: CacheStrategy;
}

interface EffectiveLlmRuntime extends OAuthLlmConfig {
  credentialId: string;
  configVersion: number;
  accessToken: string;
}

async function migrateLegacyOAuthToken(
  store: ReturnType<typeof createFileTokenStore>,
  legacyId: string,
  credentialId: string,
): Promise<void> {
  const tokens = await store.load();
  if (tokens[credentialId] !== undefined || tokens[legacyId] === undefined) return;
  tokens[credentialId] = tokens[legacyId]!;
  delete tokens[legacyId];
  await store.save(tokens);
}

function providerFromOAuthConfig(config: OAuthLlmConfig): ProviderRuntimeConfig {
  return {
    type: config.apiType === "anthropic" ? "anthropic" : "openai-compatible",
    apiType: config.apiType,
    baseURL: config.baseURL,
    defaultModel: config.defaultModel,
    cheapModel: config.cheapModel,
    models: config.models,
    ...(config.maxOutputTokens === undefined ? {} : { maxOutputTokens: config.maxOutputTokens }),
  };
}

function effectiveRuntime(result: AuthResult, credentialId: string): EffectiveLlmRuntime {
  if (result.llmConfig === undefined) throw new Error("PKCE token did not include llm_config");
  if (result.configVersion === undefined) throw new Error("PKCE token did not include config_version");
  const accessToken = result.headers.authorization?.replace(/^Bearer /, "");
  if (!accessToken) throw new Error("PKCE token did not include an access token");
  return {
    ...result.llmConfig,
    credentialId,
    configVersion: result.configVersion,
    accessToken,
  };
}

function publicEffectiveLlm(value: EffectiveLlmRuntime): Omit<EffectiveLlmRuntime, "accessToken" | "credentialId"> {
  const { accessToken: _accessToken, credentialId: _credentialId, ...visible } = value;
  return visible;
}

function selectModels(
  config: { agents?: { main?: { model: string } | undefined; subagent?: { model: string } | undefined } | undefined; providers: Record<string, ProviderRuntimeConfig> },
  registered: readonly RegisteredProvider[], diagnostics: string[],
): { main: string; child: string; mainError?: string; childError?: string } {
  const configuredMain = config.agents?.main?.model;
  const configuredProviderName = configuredMain === undefined ? undefined : safeProvider(configuredMain);
  const pkce = registered.find((item) => item.pkceManaged
    && (configuredProviderName === undefined || item.sourceName === configuredProviderName || item.name === configuredProviderName));
  if (pkce !== undefined) {
    return {
      main: `${pkce.name}:${pkce.defaultModel}`,
      child: `${pkce.name}:${pkce.cheapModel}`,
    };
  }
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

async function generateSleepReview(
  registry: ModelRegistry,
  modelId: string,
  prompt: string,
  signal: AbortSignal,
): Promise<string> {
  const { adapter, model } = registry.get(modelId);
  let output = "";
  let completed = false;
  for await (const event of adapter.stream({
    model,
    messages: [{ role: "user", content: prompt }],
    tools: [],
    signal,
  })) {
    if (event.type === "text") output += event.text;
    else if (event.type === "error") throw new Error(event.error.message);
    else if (event.type === "tool-call" || event.type === "invalid-tool-call") {
      throw new Error("Sleep reviewer attempted an unsupported tool call");
    } else if (event.type === "done") {
      completed = true;
      break;
    }
  }
  if (!completed) throw new Error("Sleep reviewer stream ended without completion");
  if (output.trim().length === 0) throw new Error("Sleep reviewer returned no text");
  return output;
}

async function optionalText(path: string): Promise<string | undefined> {
  try { return await readFile(path, "utf8"); }
  catch (error) { if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return undefined; throw error; }
}

function remove<T>(items: T[], item: T): void { const index = items.indexOf(item); if (index >= 0) items.splice(index, 1); }
function sameToolName(left: string, right: string): boolean { return left.toLowerCase() === right.toLowerCase(); }
function storedConversation(snapshot: ContextSnapshot): SessionDocument["conversation"] {
  return {
    ...(snapshot.compact === undefined ? {} : { compact: snapshot.compact }),
    ...(snapshot.epoch === undefined ? {} : { epoch: snapshot.epoch }),
    ...(snapshot.visibilityLog === undefined ? {} : { visibilityLog: snapshot.visibilityLog }),
    messages: snapshot.messages.flatMap((message) => {
      const metadata = {
        ...(message.toolCallId === undefined ? {} : { toolCallId: message.toolCallId }),
        ...(message.toolCalls === undefined ? {} : { toolCalls: message.toolCalls }),
      };
      if (message.role === "user") return { role: "user" as const, content: message.content, ...metadata };
      if (message.role === "system") return { role: "system" as const, content: message.content, ...metadata };
      if (message.role === "assistant") return { role: "assistant" as const, content: message.content, ...metadata };
      return { role: "tool" as const, content: message.content, ...metadata };
    }),
  };
}

interface CleanupProductionOptions {
  stepTimeoutMs: number;
}

async function cleanupProduction(
  approvals: ApprovalBridge, questions: QuestionBridge, pluginHost: PluginHost,
  mcpManager: McpManager | undefined, harness: LocalHarness | undefined,
  cleanupOptions: CleanupProductionOptions = { stepTimeoutMs: DEFAULT_SHUTDOWN_STEP_TIMEOUT_MS },
): Promise<void> {
  const { stepTimeoutMs } = cleanupOptions;
  let primary: unknown;
  try { approvals.resolve("deny"); }
  catch (error) { primary = error; }
  try { questions.dispose(); }
  catch (error) {
    if (primary === undefined) primary = error;
    else attachCleanupError(primary, error);
  }
  try {
    const outcome = await withTimeout(pluginHost.unloadAll(), stepTimeoutMs);
    if (outcome.timedOut) primary = new Error(`Plugin unload timed out after ${stepTimeoutMs}ms`);
  }
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
    try {
      if (mcpManager !== undefined) {
        const outcome = await withTimeout(mcpManager.close(), stepTimeoutMs);
        if (outcome.timedOut) {
          const timeoutError = new Error(`MCP shutdown timed out after ${stepTimeoutMs}ms`);
          if (primary === undefined) primary = timeoutError;
          else attachCleanupError(primary, timeoutError);
        }
      }
    }
    catch (error) {
      if (primary === undefined) primary = error;
      else attachCleanupError(primary, error);
    }
  }
  if (primary !== undefined) throw primary;
}

/**
 * Await one shutdown step with a budget. A timeout abandons the step (it keeps
 * running in the background) and records a diagnostic instead of blocking the
 * rest of the shutdown chain forever. Real errors still propagate unchanged.
 */
async function boundedStep(timeoutMs: number, diagnostics: string[], name: string, step: Promise<unknown>): Promise<void> {
  const outcome = await withTimeout(step, timeoutMs);
  if (outcome.timedOut) diagnostics.push(`Shutdown step "${name}" timed out after ${timeoutMs}ms and was abandoned.`);
}

function attachCleanupError(primary: unknown, cleanup: unknown): void {
  if ((typeof primary !== "object" && typeof primary !== "function") || primary === null || !Object.isExtensible(primary)) return;
  try { Object.defineProperty(primary, "cleanupError", { value: cleanup, configurable: true }); }
  catch { /* Preserve the primary error even when diagnostics cannot be attached. */ }
}

export async function* runGoalSession(
  orchestrator: GoalOrchestrator, goal: string, signal: AbortSignal,
): AsyncIterable<AgentEvent> {
  for await (const event of orchestrator.run({ goal, signal })) {
    if (event.type === "goal-plan-created") {
      yield { type: "notice", message: `Goal plan created (${event.plan.kind}) with ${event.plan.criteria.length} acceptance criteria.` };
      yield { type: "notice", message: `Plan file: ${event.planPath}` };
      if (event.plan.approach) {
        yield { type: "notice", message: `Approach: ${event.plan.approach}` };
      }
      continue;
    }
    if (event.type === "goal-plan-failed") {
      yield { type: "error", error: { code: "unknown", message: event.reason } };
      yield { type: "done", usage: { inputTokens: 0, outputTokens: 0 } };
      return;
    }
    if (event.type === "goal-worker-start") {
      yield { type: "notice", message: `Goal round ${event.round}: executing...` };
      continue;
    }
    if (event.type === "goal-worker-event") {
      if (event.event.type === "done") {
        yield {
          type: "usage",
          inputTokens: event.event.usage.inputTokens,
          outputTokens: event.event.usage.outputTokens,
          totalInputTokens: event.event.usage.inputTokens,
          totalOutputTokens: event.event.usage.outputTokens,
        };
      } else {
        yield event.event;
      }
      continue;
    }
    if (event.type === "goal-verification-start") {
      yield { type: "notice", message: `Goal round ${event.round}: verification panel (${3} skeptics) auditing...` };
      continue;
    }
    if (event.type === "goal-verdict") {
      if (event.outcome.type === "achieved") {
        yield { type: "notice", message: `Verdict: ACHIEVED. ${event.outcome.summary}` };
      } else if (event.outcome.type === "not_achieved") {
        yield { type: "notice", message: `Verdict: NOT ACHIEVED. ${event.outcome.summary}` };
      } else {
        yield { type: "notice", message: `Verdict: BLOCKED. ${event.outcome.reason}` };
      }
      continue;
    }
    if (event.type === "goal-complete") {
      yield { type: "notice", message: `Goal complete! ${event.summary}` };
      yield { type: "done", usage: { inputTokens: 0, outputTokens: 0 } };
      return;
    }
    if (event.type === "goal-failed") {
      yield { type: "error", error: { code: "unknown", message: event.reason } };
      yield { type: "done", usage: { inputTokens: 0, outputTokens: 0 } };
      return;
    }
    if (event.type === "goal-paused") {
      yield { type: "notice", message: `Goal paused: ${event.reason}` };
      continue;
    }
    if (event.type === "goal-stalled") {
      yield { type: "notice", message: `Goal stalled: ${event.reason}` };
      continue;
    }
  }
  yield { type: "done", usage: { inputTokens: 0, outputTokens: 0 } };
}

function memoryTranscriptHash(messages: readonly ModelMessage[]): string {
  const visible = messages.filter((item) => item.role === "user" || item.role === "assistant")
    .map((item) => `${item.role}\0${modelContentText(item.content).trim()}`).join("\n");
  return createHash("sha256").update(visible, "utf8").digest("hex");
}

function createMemoryTaskId(): string {
  return `memory-${randomUUID()}`;
}
