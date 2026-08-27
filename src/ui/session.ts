import type { AgentEvent } from "../agent/types.js";
import { redactConfig } from "../config/load.js";
import type { HookBus } from "../hooks/bus.js";
import type { PermissionMode } from "../permissions/engine.js";
import type { SkillMetadata } from "../skills/registry.js";
import { parseSlashCommand, type McpSlashCommand, type ModelRole, type SlashCommand } from "./commands.js";
import type { QuestionBridge } from "../tools/ask-user-question.js";
import { message } from "../utils/error.js";
import type { MemoryType } from "../memory/types.js";
import { AgentMessageQueue, type AgentQueueSnapshot } from "../agent/message-queue.js";
import type { SessionTreeNode } from "../session/tree.js";
import {
  modelContentTranscriptText,
  type ModelContentBlock,
  type ModelMessage,
} from "../models/types.js";
import type { IdeEditorContext } from "../ide/client.js";
import { buildPalCoWorkPlanningPrompt, buildPalCoWorkPrompt, buildPalTaskPrompt } from "../pals/prompt.js";

export interface SessionApprovalRequest {
  id: string;
  agent: "main" | "subagent";
  tool: string;
  reason?: string;
  paths?: readonly string[];
  command?: string;
  args?: readonly string[];
  cwd?: string;
}

export type SessionOutput = AgentEvent
  | { type: "notice"; message: string }
  | ({ type: "pal-task"; status: "received" } & PalTaskDelivery)
  | ({ type: "cowork-event" } & PalCoWorkDelivery)
  | { type: "queued-prompt"; prompt: string }
  | { type: "queued-remote-prompt"; prompt: string; senderId: string; senderAlias: string; context?: "CO-WORK PLANNING" | "CO-WORK EXECUTION" }
  | { type: "write-start"; id: string; path: string; before: string; totalBytes: number }
  | { type: "write-delta"; id: string; delta: string }
  | { type: "write-ready"; id: string }
  | { type: "write-cancelled"; id: string }
  | { type: "approval-request"; request: SessionApprovalRequest }
  | { type: "approval-cleared"; id?: string }
  | { type: "clear" }
  | { type: "exit" };

export interface PalTaskDelivery {
  readonly senderId: string;
  readonly senderAlias: string;
  readonly messageId: string;
  readonly taskId: string;
  readonly goal: string;
}

interface PalCoWorkDeliveryBase {
  readonly senderId: string;
  readonly senderAlias: string;
  readonly localId?: string;
  readonly coWorkId: string;
  readonly epoch: number;
  readonly snapshot: unknown;
}

export type PalCoWorkDelivery = PalCoWorkDeliveryBase & (
  | { readonly action: "START"; readonly planHash: string }
  | { readonly action: "PROPOSE" | "PLAN" | "END" | "FAIL" | "CANCEL"; readonly planHash: string | null }
);

export interface PalSessionServices {
  list(verbose: boolean): Promise<unknown>;
  rename(alias: string): Promise<unknown>;
  info(target: string): Promise<unknown>;
  sendChat?(target: string, message: string): Promise<unknown>;
  sendTask(target: string, goal: string): Promise<unknown>;
  startCoWork(target: string, goal: string): Promise<unknown>;
  coWorkStatus(coWorkId?: string): Promise<unknown>;
  cancelCoWork(coWorkId: string, reason?: string): Promise<unknown>;
}

export interface SessionServices {
  hooks: HookBus;
  workspace: string;
  mainModel(): string;
  subagentModel(): string;
  llmServiceName?(): string | undefined;
  permissionMode(): PermissionMode;
  addContext?(content: string): void | Promise<void>;
  run(
    prompt: string,
    signal: AbortSignal,
    options?: {
      getSteeringMessages(): readonly string[];
      initialUserMessage?: Extract<ModelMessage, { role: "user" }>;
      additionalContext?: string;
    },
  ): AsyncIterable<AgentEvent>;
  runSkill(skill: string, prompt: string, signal: AbortSignal): AsyncIterable<AgentEvent>;
  runLoop(goal: string, signal: AbortSignal): AsyncIterable<AgentEvent>;
  runGoal(goal: string, signal: AbortSignal): AsyncIterable<AgentEvent>;
  mcp(command: McpSlashCommand, signal: AbortSignal): Promise<string>;
  ide?(): Promise<string>;
  ideContext?(): Promise<IdeEditorContext | undefined>;
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
  evolve(args: readonly string[]): string | Promise<string>;
  gitCommit?(hint: string | undefined, signal: AbortSignal): Promise<string>;
  gitReview?(focus: string | undefined, signal: AbortSignal): Promise<string>;
  explain?(query: string | undefined, focus: string | undefined, signal: AbortSignal): Promise<string>;
  usage(): string | Promise<string>;
  cancelActiveTask(): void | Promise<void>;
  clearContext(): void | Promise<void>;
  checkpoint?(label?: string): Promise<SessionTreeNode>;
  tree?(): readonly SessionTreeNode[];
  historyLeaf?(): string | null;
  rewind?(nodeId: string): Promise<void>;
  unrevert?(): Promise<void>;
  fork?(nodeId: string): Promise<void>;
  memory(): Promise<string>;
  refreshMemory?(): Promise<void>;
  remember(type: MemoryType, text: string): Promise<string>;
  forget(query: string): Promise<string>;
  forgetCold(): Promise<string>;
  finishTask(): Promise<string>;
  pluginCommands(): readonly { name: string; description?: string }[];
  runPluginCommand(name: string, args: readonly string[], signal: AbortSignal): Promise<unknown>;
  managedToolCommands(): readonly { name: string; description?: string }[];
  runManagedTool(name: string, input: string, signal: AbortSignal): Promise<unknown>;
  output(event: SessionOutput): void;
  questions: QuestionBridge;
  login(): Promise<string>;
  logout(): Promise<string>;
  pals?: PalSessionServices;
  durableQueue?: {
    recover(): readonly { id: string; kind: "steer" | "followUp"; payload: unknown }[];
    admit(kind: "steer" | "followUp", payload: unknown): string;
    claim(id: string): void;
    ack(id: string): void;
    release(id: string, reason: string): void;
  };
}

export interface MultimodalSessionInput {
  text: string;
  content: ModelContentBlock[];
}

type NormalizedSubmission = {
  text: string;
  displayText: string;
  initialUserMessage?: Extract<ModelMessage, { role: "user" }>;
  remoteOrigin?: {
    senderId: string;
    senderAlias: string;
    prompt: string;
    context?: "CO-WORK PLANNING" | "CO-WORK EXECUTION";
  };
  coWorkPlanningKey?: string;
  controlOnly?: boolean;
  durableId?: string;
};

type CoWorkFlow = { epoch: number; status: "planning" | "started" | "terminal" };

const HELP = [
  "/model <main|subagent> <provider:model>  switch any configured model",
  "/permissions <default|acceptEdits|plan|bypassPermissions|auto|bubble>",
  "/login                                  authenticate via OAuth PKCE",
  "/logout                                 clear stored OAuth credentials",
  "/init  /config  /skills  /plugins  /hooks  /tasks",
  "/memory  /remember [type] <text>  /forget <text-or-id>  /forget-cold  /finish",
  "/checkpoint [label]  /tree  /rewind <node>  /unrevert  /fork <node>",
  "/compact  /clear  /help  /exit",
  "/loop <goal>                            run a verified autonomous loop",
  "/goal <objective>                       run a goal pipeline with adversarial verification",
  "/commit [hint]                          draft a commit message for staged changes and commit",
  "/review [focus]                         review uncommitted changes before committing",
  "/evolve <signals|suggest|improve <id>|verify <name>|reload <name>|test|revert <name>|done <id>>  self-improvement loop",
  "/mcp [status|tools|reconnect|enable|disable]  manage MCP servers",
  "/tool <registered-tool> [JSON object]      run a registered tool (or use /<tool-name>)",
  "/ide                                     show VS Code connection and cursor/selection",
  "/pals [--verbose|rename <alias>|info <alias-or-uuid>]",
  "/chat <alias-or-uuid> <goal>             send a task that starts on the receiving pal",
  "/co-work <pal> <goal> | status [id] | cancel <id> [reason]",
].join("\n");

export class FlavorSession {
  readonly #services: SessionServices;
  #active: AbortController | undefined;
  #started = false;
  #closed = false;
  #interrupted = false;
  #startPromise: Promise<void> | undefined;
  #submissionTail: Promise<void> = Promise.resolve();
  #coWorkEventTail: Promise<void> = Promise.resolve();
  #pendingSubmissions = 0;
  #closePromise: Promise<void> | undefined;
  readonly #queue = new AgentMessageQueue();
  readonly #queuedSubmissions: Record<"steer" | "followUp", NormalizedSubmission[]> = { steer: [], followUp: [] };
  readonly #seenPalTasks = new Set<string>();
  readonly #seenCoWorkEvents = new Set<string>();
  readonly #coWorkFlows = new Map<string, CoWorkFlow>();
  readonly #planningMembers = new Set<string>();
  readonly #activePlanning = new Set<string>();
  readonly #planningIdleWaiters = new Set<() => void>();
  readonly #pendingCoWorkStarts: NormalizedSubmission[] = [];
  readonly #activeSteeringDurableIds = new Set<string>();
  #durableResumeStarted = false;
  #permissionBaseline: PermissionMode | undefined;
  #activeSubmission: NormalizedSubmission | undefined;

  constructor(services: SessionServices) {
    this.#services = services;
    for (const item of services.durableQueue?.recover() ?? []) {
      const submission = recoveredSubmission(item.payload);
      if (submission === undefined) {
        services.durableQueue?.ack(item.id);
        continue;
      }
      this.#queue.enqueue(item.kind, submission.text);
      this.#queuedSubmissions[item.kind].push({ ...submission, durableId: item.id });
    }
  }

  get active(): boolean { return this.#active !== undefined; }
  queueSnapshot(): AgentQueueSnapshot { return this.#queue.snapshot(); }
  clearQueue(): AgentQueueSnapshot {
    const snapshot = this.#queue.clear();
    for (const kind of ["steer", "followUp"] as const) {
      for (const submission of this.#queuedSubmissions[kind]) {
        if (submission.durableId !== undefined) this.#services.durableQueue?.ack(submission.durableId);
      }
    }
    this.#queuedSubmissions.steer.length = 0;
    this.#queuedSubmissions.followUp.length = 0;
    return snapshot;
  }
  async whenIdle(): Promise<void> {
    await this.#coWorkEventTail.catch(() => {});
    await this.#submissionTail;
  }

  steer(input: string): void {
    if (this.#closed) throw new Error("Session is closed");
    if (this.active || this.#pendingSubmissions > 0) {
      this.#enqueueMessage("steer", normalizeRequiredSubmission(input));
      this.#notice(`Steering queued (${this.#queue.snapshot().steering.length} pending).`);
    } else this.#submitFireAndForget(input);
  }

  followUp(input: string): void {
    if (this.#closed) throw new Error("Session is closed");
    if (this.active || this.#pendingSubmissions > 0) {
      this.#enqueueMessage("followUp", normalizeRequiredSubmission(input));
      this.#notice(`Follow-up queued (${this.#queue.snapshot().followUp.length} pending).`);
    } else this.#submitFireAndForget(input);
  }

  #submitFireAndForget(input: string): void {
    // Unattended submissions must never surface as unhandled rejections:
    // hook timeouts (e.g. slow Stop-hook work) would otherwise crash the process.
    this.submit(input).catch((error) => {
      this.#services.output({ type: "error", error: { code: "unknown", message: message(error) } });
    });
  }

  receivePalTask(input: PalTaskDelivery): void {
    if (this.#closed) return;
    if (!this.#rememberEvent(this.#seenPalTasks, input.messageId)) return;
    this.#services.output({ type: "pal-task", status: "received", ...input });
    this.#enqueueRemotePrompt(buildPalTaskPrompt({
      senderId: input.senderId,
      senderAlias: input.senderAlias,
      messageId: input.messageId,
      remoteText: input.goal,
    }), {
      senderId: input.senderId, senderAlias: input.senderAlias, prompt: input.goal,
    });
  }

  receivePalCoWorkEvent(input: PalCoWorkDelivery): Promise<void> {
    if (this.#closed) return Promise.resolve();
    const operation = this.#coWorkEventTail.catch(() => {}).then(() => this.#processPalCoWorkEvent(input));
    this.#coWorkEventTail = operation;
    return operation;
  }

  async #processPalCoWorkEvent(input: PalCoWorkDelivery): Promise<void> {
    if (this.#closed) return;
    const eventIdentity = `${input.coWorkId}:${input.epoch}:${input.action}:${input.planHash ?? "none"}`;
    if (!this.#rememberEvent(this.#seenCoWorkEvents, eventIdentity)) return;
    this.#services.output({ type: "cowork-event", ...input });
    const current = this.#coWorkFlows.get(input.coWorkId);
    if (current !== undefined && input.epoch < current.epoch) return;
    if (current !== undefined && input.epoch > current.epoch) {
      this.#planningMembers.delete(coWorkKey(input.coWorkId, current.epoch));
      this.#coWorkFlows.delete(input.coWorkId);
    }
    const existing = this.#coWorkFlows.get(input.coWorkId);
    if (input.action === "END" || input.action === "FAIL" || input.action === "CANCEL") {
      const key = coWorkKey(input.coWorkId, input.epoch);
      if (existing?.epoch === input.epoch && existing.status === "terminal") return;
      this.#coWorkFlows.set(input.coWorkId, { epoch: input.epoch, status: "terminal" });
      this.#planningMembers.delete(key);
      if (this.#activeSubmission?.coWorkPlanningKey === key) {
        this.#stopActivePlanning(input, key);
        await this.#waitForPlanningIdle(key);
      }
      await this.#releasePlanningGateIfSafe();
      return;
    }
    if (input.action === "PROPOSE" || input.action === "PLAN") {
      if (existing?.epoch === input.epoch && existing.status !== "planning") return;
      const key = coWorkKey(input.coWorkId, input.epoch);
      this.#coWorkFlows.set(input.coWorkId, { epoch: input.epoch, status: "planning" });
      if (!isRequiredCoWorkParticipant(input.snapshot, input.localId)) return;
      this.#planningMembers.add(key);
      const planningPrompt = buildPalCoWorkPlanningPrompt({ ...input, action: input.action });
      const submission: NormalizedSubmission = {
        text: planningPrompt,
        displayText: planningPrompt,
        remoteOrigin: {
          senderId: input.senderId, senderAlias: input.senderAlias,
          prompt: coWorkDisplayPrompt(input.snapshot), context: "CO-WORK PLANNING",
        },
        coWorkPlanningKey: key,
      };
      if (this.#activeSubmission?.coWorkPlanningKey === key) this.#enqueueMessage("steer", submission);
      else this.#queueOrSubmitRemote(submission, "followUp");
      return;
    }
    if (input.action !== "START" || input.planHash === null) return;
    if (existing?.epoch === input.epoch && existing.status !== "planning") return;
    const key = coWorkKey(input.coWorkId, input.epoch);
    this.#coWorkFlows.set(input.coWorkId, { epoch: input.epoch, status: "started" });
    this.#planningMembers.delete(key);
    if (!isRequiredCoWorkParticipant(input.snapshot, input.localId)) {
      await this.#releasePlanningGateIfSafe();
      return;
    }
    const startPrompt = buildPalCoWorkPrompt({
      senderId: input.senderId,
      senderAlias: input.senderAlias,
      messageId: `cowork:${eventIdentity}`,
      coWorkId: input.coWorkId,
      epoch: input.epoch,
      planHash: input.planHash,
      snapshot: input.snapshot,
      ...(input.localId === undefined ? {} : { localId: input.localId }),
    });
    this.#pendingCoWorkStarts.push({
      text: startPrompt,
      displayText: startPrompt,
      remoteOrigin: {
        senderId: input.senderId, senderAlias: input.senderAlias,
        prompt: coWorkDisplayPrompt(input.snapshot), context: "CO-WORK EXECUTION",
      },
    });
    if (this.#activeSubmission?.coWorkPlanningKey === key) {
      this.#stopActivePlanning(input, key);
      await this.#waitForPlanningIdle(key);
    }
    await this.#releasePlanningGateIfSafe();
  }

  async start(): Promise<void> {
    if (this.#started) return;
    if (this.#closed) throw new Error("Session is closed");
    this.#startPromise ??= this.#services.hooks.emit({
      version: 1, type: "SessionStart", payload: { workspace: this.#services.workspace },
    }).then(async (decision) => {
      if (decision.additionalContext !== undefined) await this.#services.addContext?.(decision.additionalContext);
      this.#started = true;
      this.#resumeDurableQueue();
    });
    return this.#startPromise;
  }

  async submit(input: string): Promise<void>;
  async submit(input: MultimodalSessionInput): Promise<void>;
  async submit(input: string | MultimodalSessionInput): Promise<void> {
    if (this.#closed) throw new Error("Session is closed");
    const submission = normalizeSubmission(input);
    if (submission === undefined) return;
    return this.#enqueueNormalizedSubmission(submission);
  }

  #enqueueNormalizedSubmission(submission: NormalizedSubmission): Promise<void> {
    this.#pendingSubmissions += 1;
    const operation = this.#submissionTail.catch(() => {}).then(() => this.#runSubmissionChain(submission))
      .finally(() => {
        this.#pendingSubmissions -= 1;
        if (this.#pendingSubmissions === 0) this.#resumeDurableQueue();
      });
    this.#submissionTail = operation;
    return operation;
  }

  async #runSubmissionChain(initialSubmission: NormalizedSubmission): Promise<void> {
    const pending = [initialSubmission];
    let initial = true;
    while (pending.length > 0) {
      const submission = pending.shift()!;
      if (!this.#isSubmissionCurrent(submission) || submission.controlOnly === true) {
        this.#ackDurable(submission);
        pending.push(...this.#drainMessages("steer"), ...this.#drainMessages("followUp"));
        continue;
      }
      if (!initial) this.#outputQueuedSubmission(submission);
      initial = false;
      await this.#runSubmission(submission);
      pending.push(...this.#drainMessages("steer"), ...this.#drainMessages("followUp"));
    }
  }

  async #runSubmission(submission: NormalizedSubmission): Promise<void> {
    const prompt = submission.text;
    await this.start();
    if (this.#closed) throw new Error("Session is closed");
    if (!this.#isSubmissionCurrent(submission)) { this.#ackDurable(submission); return; }
    if (submission.coWorkPlanningKey !== undefined) {
      if (!await this.#activatePlanningGate(submission.coWorkPlanningKey)) { this.#ackDurable(submission); return; }
    }
    if (submission.durableId !== undefined) this.#services.durableQueue?.claim(submission.durableId);
    const controller = new AbortController();
    this.#active = controller;
    this.#activeSubmission = submission;
    this.#interrupted = false;
    let outcome = "completed";
    let assistantSummary = "";
    let deliverables: readonly import("../agent/types.js").TurnDeliverable[] = [];
    try {
      const decision = await this.#services.hooks.emit({
        version: 1, type: "UserPromptSubmit", payload: { prompt: submission.displayText },
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
      const command = parseSlashCommand(
        prompt,
        this.#services.pluginCommands().map(({ name }) => name),
        skillNames,
        this.#services.managedToolCommands().map(({ name }) => name),
      );
      if (command !== null) await this.#dispatch(command, controller.signal);
      else for await (const event of this.#services.run(prompt, controller.signal, {
        getSteeringMessages: () => this.#drainMessages("steer", true).map((item) => item.text),
        ...(decision.additionalContext === undefined
          ? {}
          : { additionalContext: decision.additionalContext }),
        ...(submission.initialUserMessage === undefined
          ? {}
          : { initialUserMessage: submission.initialUserMessage }),
      })) {
        this.#services.output(event);
        if (event.type === "text") assistantSummary = `${assistantSummary}${event.text}`.slice(-2_000);
        if (event.type === "deliverables") deliverables = event.files.slice(0, 100);
        if (event.type === "error") outcome = "failed";
      }
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
        this.#activeSubmission = undefined;
        if (submission.coWorkPlanningKey !== undefined) this.#finishActivePlanning(submission.coWorkPlanningKey);
        try {
          await this.#services.hooks.emit({
            version: 1,
            type: "Stop",
            payload: {
              outcome,
              ...(assistantSummary.trim() ? { summary: assistantSummary.trim() } : {}),
              ...(deliverables.length === 0 ? {} : { deliverables }),
            },
          });
        } catch (error) {
          // Stop-hook failures (e.g. handler timeouts) must not reject the
          // submission chain — remote submissions are fire-and-forget, and an
          // escaping TimeoutError would crash the process.
          try { this.#services.output({ type: "error", error: { code: "unknown", message: message(error) } }); }
          catch { /* Never let cleanup failures escape. */ }
        }
        this.#ackDurable(submission);
        this.#ackActiveSteering();
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
    this.#planningMembers.clear();
    this.#pendingCoWorkStarts.length = 0;
    this.#active?.abort(new Error("Session closed"));
    await this.#coWorkEventTail.catch(() => {});
    await this.#submissionTail.catch(() => {});
    if (this.#permissionBaseline !== undefined) {
      const baseline = this.#permissionBaseline;
      await this.#services.setPermissionMode(baseline);
      this.#permissionBaseline = undefined;
    }
    await this.#startPromise?.catch(() => {});
    if (this.#started) await this.#services.hooks.emit({
      version: 1, type: "SessionEnd", payload: { workspace: this.#services.workspace },
    }).catch(() => { /* Shutdown hooks are best-effort; never fail close(). */ });
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
    } else if (command.name === "managed-tool") {
      this.#notice(format(await this.#services.runManagedTool(command.tool, command.input, signal)));
    } else if (command.name === "skill") {
      for await (const event of this.#services.runSkill(command.skill, command.prompt, signal)) this.#services.output(event);
    } else if (command.name === "loop") {
      for await (const event of this.#services.runLoop(command.goal, signal)) this.#services.output(event);
    } else if (command.name === "goal") {
      for await (const event of this.#services.runGoal(command.goal, signal)) this.#services.output(event);
    } else if (command.name === "commit") {
      this.#notice(await required(this.#services.gitCommit, "commit")(command.hint, signal));
    } else if (command.name === "review") {
      this.#notice(await required(this.#services.gitReview, "review")(command.focus, signal));
    } else if (command.name === "explain") {
      this.#notice(await required(this.#services.explain, "explain")(command.query, command.focus, signal));
    } else if (command.name === "mcp") {
      this.#notice(await this.#services.mcp(command, signal));
    } else if (command.name === "pals") {
      const pals = requiredPals(this.#services.pals);
      if (command.action === "list") this.#collaborationNotice(format(await pals.list(command.verbose)));
      else if (command.action === "rename") this.#collaborationNotice(format(await pals.rename(command.alias)));
      else this.#collaborationNotice(format(await pals.info(command.target)));
    } else if (command.name === "chat") {
      this.#collaborationNotice(format(await requiredPals(this.#services.pals).sendTask(command.target, command.goal)));
    } else if (command.name === "co-work") {
      const pals = requiredPals(this.#services.pals);
      if (command.action === "start") {
        this.#collaborationNotice(format(await pals.startCoWork(command.target, command.goal)));
      } else if (command.action === "status") {
        this.#collaborationNotice(format(await pals.coWorkStatus(command.coWorkId)));
      } else {
        this.#collaborationNotice(format(await pals.cancelCoWork(command.coWorkId, command.reason)));
      }
    } else if (command.name === "ide") {
      this.#notice(await required(this.#services.ide, "ide")());
    } else if (command.name === "memory") {
      this.#notice(await this.#services.memory());
    } else if (command.name === "remember") {
      this.#notice(await this.#services.remember(command.type, command.text));
    } else if (command.name === "forget") {
      this.#notice(await this.#services.forget(command.query));
    } else if (command.name === "forget-cold") {
      this.#notice(await this.#services.forgetCold());
    } else if (command.name === "finish") {
      this.#notice(await this.#services.finishTask());
    } else if (command.name === "checkpoint") {
      this.#notice(format(await required(this.#services.checkpoint, "checkpoint")(command.label)));
    } else if (command.name === "tree") {
      this.#notice(format(required(this.#services.tree, "tree")()));
    } else if (command.name === "rewind") {
      await required(this.#services.rewind, "rewind")(command.nodeId);
      this.#notice(`Rewound to ${command.nodeId}.`);
    } else if (command.name === "unrevert") {
      await required(this.#services.unrevert, "unrevert")();
      this.#notice("Rewind undone.");
    } else if (command.name === "fork") {
      await required(this.#services.fork, "fork")(command.nodeId);
      this.#notice(`Forked context from ${command.nodeId}.`);
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
    else if (command.name === "evolve") this.#notice(await this.#services.evolve(command.args));
    else if (command.name === "usage") this.#notice(await this.#services.usage());
    else if (command.name === "clear") {
      await this.#services.clearContext();
      this.#services.output({ type: "clear" });
    }
    else if (command.name === "login") {
      this.#notice("Opening browser for authentication...");
      this.#notice(await this.#services.login());
    }
    else if (command.name === "logout") {
      this.#notice(await this.#services.logout());
    }
    else if (command.name === "help") this.#notice(HELP);
    else if (command.name === "exit") this.#services.output({ type: "exit" });
  }

  #notice(message: string): void { this.#services.output({ type: "notice", message }); }
  #collaborationNotice(message: string): void {
    const limit = 8_192;
    this.#notice(message.length <= limit ? message : `${message.slice(0, limit - 1)}…`);
  }

  #enqueueRemotePrompt(prompt: string, remoteOrigin: NonNullable<NormalizedSubmission["remoteOrigin"]>): void {
    this.#queueOrSubmitRemote({ text: prompt, displayText: prompt, remoteOrigin }, "steer");
  }

  #queueOrSubmitRemote(submission: NormalizedSubmission, activeKind: "steer" | "followUp"): void {
    if (this.#closed) return;
    if (this.active) {
      this.#enqueueMessage(activeKind, submission);
      return;
    }
    if (this.#pendingSubmissions > 0) {
      this.#enqueueMessage("followUp", submission);
      return;
    }
    this.#enqueueNormalizedSubmission(submission).catch((error) => {
      this.#services.output({ type: "error", error: { code: "unknown", message: message(error) } });
    });
  }

  #enqueueMessage(kind: "steer" | "followUp", submission: NormalizedSubmission): void {
    const durableId = submission.durableId ?? this.#services.durableQueue?.admit(kind, durablePayload(submission));
    this.#queue.enqueue(kind, submission.text);
    this.#queuedSubmissions[kind].push(durableId === undefined ? submission : { ...submission, durableId });
  }

  #drainMessages(kind: "steer" | "followUp", activeSteering = false): NormalizedSubmission[] {
    const prompts = this.#queue.drain(kind);
    return prompts.map((prompt) => {
      const submission = this.#queuedSubmissions[kind].shift() ?? normalizeRequiredSubmission(prompt);
      if (activeSteering && submission.durableId !== undefined) {
        this.#services.durableQueue?.claim(submission.durableId);
        this.#activeSteeringDurableIds.add(submission.durableId);
      }
      return submission;
    });
  }

  #resumeDurableQueue(): void {
    if (this.#durableResumeStarted || this.#closed || this.active || this.#pendingSubmissions > 0) return;
    if (!this.#queue.hasPending) return;
    this.#durableResumeStarted = true;
    const submissions = [...this.#drainMessages("steer"), ...this.#drainMessages("followUp")];
    if (submissions.length === 0) return;
    this.#notice("Resuming a queued prompt recovered from the durable harness journal.");
    for (const submission of submissions) {
      this.#enqueueNormalizedSubmission(submission).catch((error) => {
        this.#services.output({ type: "error", error: { code: "unknown", message: message(error) } });
      });
    }
  }

  #ackDurable(submission: NormalizedSubmission): void {
    if (submission.durableId === undefined) return;
    this.#services.durableQueue?.ack(submission.durableId);
    this.#activeSteeringDurableIds.delete(submission.durableId);
  }

  #ackActiveSteering(): void {
    for (const id of this.#activeSteeringDurableIds) this.#services.durableQueue?.ack(id);
    this.#activeSteeringDurableIds.clear();
  }

  #outputQueuedSubmission(submission: NormalizedSubmission): void {
    const origin = submission.remoteOrigin;
    if (origin === undefined) {
      this.#services.output({ type: "queued-prompt", prompt: submission.displayText });
      return;
    }
    this.#services.output({
      type: "queued-remote-prompt",
      prompt: origin.prompt,
      senderId: origin.senderId,
      senderAlias: origin.senderAlias,
      ...(origin.context === undefined ? {} : { context: origin.context }),
    });
  }

  #isSubmissionCurrent(submission: NormalizedSubmission): boolean {
    const key = submission.coWorkPlanningKey;
    if (key === undefined) return true;
    const [coWorkId, epochText] = splitCoWorkKey(key);
    const flow = this.#coWorkFlows.get(coWorkId);
    return flow?.epoch === Number(epochText) && flow.status === "planning";
  }

  async #activatePlanningGate(key: string): Promise<boolean> {
    if (!this.#planningMembers.has(key)) return false;
    if (this.#permissionBaseline === undefined) this.#permissionBaseline = this.#services.permissionMode();
    if (this.#services.permissionMode() !== "plan") await this.#services.setPermissionMode("plan");
    if (!this.#planningMembers.has(key)) return false;
    this.#activePlanning.add(key);
    return true;
  }

  #finishActivePlanning(key: string): void {
    this.#activePlanning.delete(key);
    const waiters = [...this.#planningIdleWaiters];
    this.#planningIdleWaiters.clear();
    for (const waiter of waiters) waiter();
  }

  #waitForPlanningIdle(key: string): Promise<void> {
    if (!this.#activePlanning.has(key)) return Promise.resolve();
    return new Promise((resolve) => {
      const check = (): void => {
        if (!this.#activePlanning.has(key)) resolve();
        else this.#planningIdleWaiters.add(check);
      };
      this.#planningIdleWaiters.add(check);
    });
  }

  #stopActivePlanning(input: PalCoWorkDelivery, key: string): void {
    if (this.#activeSubmission?.coWorkPlanningKey !== key || this.#active === undefined) return;
    const alias = input.senderAlias.slice(0, 120);
    const stop = `PAL co-work ${input.action} from ${alias} (${input.coWorkId.slice(0, 8)}): stop this planning turn; do not execute stale work.`;
    this.#enqueueMessage("steer", { text: stop, displayText: stop, controlOnly: true });
    this.#active.abort(new Error(stop));
  }

  async #releasePlanningGateIfSafe(): Promise<void> {
    if (this.#planningMembers.size > 0 || this.#activePlanning.size > 0) return;
    if (this.#permissionBaseline !== undefined) {
      const baseline = this.#permissionBaseline;
      await this.#services.setPermissionMode(baseline);
      this.#permissionBaseline = undefined;
    }
    const starts = this.#pendingCoWorkStarts.splice(0);
    for (const submission of starts) this.#queueOrSubmitRemote(submission, "followUp");
  }

  #rememberEvent(seen: Set<string>, identity: string): boolean {
    if (seen.has(identity)) return false;
    seen.add(identity);
    const limit = 2_048;
    while (seen.size > limit) {
      const oldest = seen.values().next().value as string | undefined;
      if (oldest === undefined) break;
      seen.delete(oldest);
    }
    return true;
  }
}

function normalizeSubmission(input: string | MultimodalSessionInput): NormalizedSubmission | undefined {
  if (typeof input === "string") {
    const text = input.trim();
    return text ? { text, displayText: text } : undefined;
  }
  const text = input.text.trim() || "Analyze the attached image(s).";
  if (input.content.length === 0) return { text, displayText: text };
  const content = input.content.some((block) => block.type === "text")
    ? input.content
    : [{ type: "text" as const, text }, ...input.content];
  return {
    text,
    displayText: modelContentTranscriptText(content),
    initialUserMessage: { role: "user", content },
  };
}

function normalizeRequiredSubmission(input: string): NormalizedSubmission {
  const normalized = normalizeSubmission(input);
  if (normalized === undefined) throw new Error("Cannot queue an empty message");
  return normalized;
}

function durablePayload(submission: NormalizedSubmission): unknown {
  const { durableId: _durableId, ...payload } = submission;
  return structuredClone(payload);
}

function recoveredSubmission(value: unknown): NormalizedSubmission | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const input = value as Partial<NormalizedSubmission>;
  if (typeof input.text !== "string" || input.text.trim().length === 0) return undefined;
  if (typeof input.displayText !== "string") return undefined;
  if (input.controlOnly !== undefined && typeof input.controlOnly !== "boolean") return undefined;
  if (input.coWorkPlanningKey !== undefined && typeof input.coWorkPlanningKey !== "string") return undefined;
  if (input.remoteOrigin !== undefined) {
    const origin = input.remoteOrigin;
    if (typeof origin.senderId !== "string" || typeof origin.senderAlias !== "string" || typeof origin.prompt !== "string") return undefined;
  }
  return structuredClone(input as NormalizedSubmission);
}

function coWorkKey(coWorkId: string, epoch: number): string { return `${coWorkId}:${epoch}`; }

function splitCoWorkKey(key: string): [string, string] {
  const separator = key.lastIndexOf(":");
  return [key.slice(0, separator), key.slice(separator + 1)];
}

function coWorkDisplayPrompt(snapshot: unknown): string {
  if (typeof snapshot !== "object" || snapshot === null) return "Co-work update";
  const goal = (snapshot as { goal?: unknown }).goal;
  return typeof goal === "string" && goal.length > 0 ? goal : "Co-work update";
}

function isRequiredCoWorkParticipant(snapshot: unknown, localId: string | undefined): boolean {
  if (localId === undefined) return true;
  if (typeof snapshot !== "object" || snapshot === null) return false;
  const participants = (snapshot as { participants?: unknown }).participants;
  if (!Array.isArray(participants)) return true;
  return participants.some((participant) => {
    if (typeof participant !== "object" || participant === null) return false;
    const value = participant as { palId?: unknown; required?: unknown };
    return value.palId === localId && value.required === true;
  });
}

function format(value: unknown): string {
  if (Array.isArray(value) && value.length === 0) return "None registered.";
  return JSON.stringify(value, null, 2) ?? String(value);
}

function required<T extends (...args: never[]) => unknown>(service: T | undefined, name: string): T {
  if (service === undefined) throw new Error(`Session history command /${name} is unavailable`);
  return service;
}

function requiredPals(service: PalSessionServices | undefined): PalSessionServices {
  if (service === undefined) throw new Error("Pal collaboration commands are unavailable");
  return service;
}

