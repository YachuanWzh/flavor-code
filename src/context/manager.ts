import type { HookBus } from "../hooks/bus.js";
import type { ModelMessage } from "../models/types.js";
import { awaitWithSignal } from "../utils/async.js";
import {
  DEFAULT_COMPACTION_POLICY,
  calculateContextPressure,
  compactContinuationMessage,
  estimateMessageTokens,
  formatCompactSummary,
  microcompactMessages,
  selectRecentStart,
  type CompactionPolicy,
} from "./compaction.js";

export interface ContextManagerOptions {
  system: SystemPromptSource;
  flavor?: string;
  memory?: string;
  taskState?: string;
  /** @deprecated Prefer token-based compaction policy. */
  compactAtChars?: number;
  toolOutputChars: number;
  compaction?: Partial<CompactionPolicy>;
  recentTurns?: number;
  /** @deprecated Prefer recentTurns. */
  recentMessages?: number;
  summarize(messages: readonly ModelMessage[], signal: AbortSignal, onProgress?: CompactProgressCallback): Promise<string>;
  onCompactProgress?: CompactProgressCallback;
  hooks: HookBus;
}

export type CompactProgressCallback = (percentage: number) => void;

export type SystemPromptSource = string | readonly string[] | (() => string | readonly string[]);

export interface ContextSnapshot {
  compact?: CompactBoundary;
  /** @deprecated Version 1 session compatibility. */
  summary?: { role: "system"; content: string };
  messages: ModelMessage[];
}

export interface CompactBoundary {
  summary: string;
  compactedAt: string;
}

export type CompactReason = "manual" | "reactive";

export type ContextForkOptions = Partial<Pick<
  ContextManagerOptions,
  "summarize" | "onCompactProgress" | "hooks"
>>;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export class ContextManager {
  readonly #system: SystemPromptSource;
  readonly #flavor: string | undefined;
  readonly #memory: string | undefined;
  readonly #compactAtChars: number;
  readonly #toolOutputChars: number;
  readonly #recentTurns: number | undefined;
  readonly #compaction: CompactionPolicy;
  readonly #summarize: ContextManagerOptions["summarize"];
  readonly #onCompactProgress: CompactProgressCallback | undefined;
  readonly #hooks: HookBus;
  #taskState: string | undefined;
  #compact: CompactBoundary | undefined;
  #messages: ModelMessage[] = [];
  #lastRecordedInputTokens: number | undefined;
  #estimatedTokensAtLastRecordedUsage: number | undefined;
  #consecutiveAutoCompactFailures = 0;
  #lastCompactProgress: number | undefined;
  #forkPinnedBoundary = false;
  #forkCompactBoundary = false;

  constructor(options: ContextManagerOptions) {
    if (options.compactAtChars !== undefined && options.compactAtChars <= 0) throw new Error("compactAtChars must be positive");
    if (options.toolOutputChars <= 0) throw new Error("toolOutputChars must be positive");
    const recentTurns = options.recentTurns ?? options.recentMessages;
    if (recentTurns !== undefined && recentTurns < 0) throw new Error("recentTurns must not be negative");
    const compaction = { ...DEFAULT_COMPACTION_POLICY, ...options.compaction };
    for (const [name, value] of Object.entries(compaction)) {
      if (!Number.isInteger(value) || value < 0) throw new Error(`compaction.${name} must be a non-negative integer`);
    }
    if (compaction.windowTokens <= 0) throw new Error("compaction.windowTokens must be positive");
    if (compaction.reservedOutputTokens >= compaction.windowTokens) throw new Error("compaction.reservedOutputTokens must be below windowTokens");
    if (compaction.maxRecentTokens < compaction.recentTokens) throw new Error("compaction.maxRecentTokens must be at least recentTokens");
    this.#system = options.system;
    this.#flavor = options.flavor;
    this.#memory = options.memory;
    this.#taskState = options.taskState;
    this.#compactAtChars = options.compactAtChars ?? Number.POSITIVE_INFINITY;
    this.#toolOutputChars = options.toolOutputChars;
    this.#recentTurns = recentTurns;
    this.#compaction = compaction;
    this.#summarize = options.summarize;
    this.#onCompactProgress = options.onCompactProgress;
    this.#hooks = options.hooks;
  }

  clear(): void {
    this.#compact = undefined;
    this.#messages = [];
    this.#taskState = undefined;
    this.#lastRecordedInputTokens = undefined;
    this.#estimatedTokensAtLastRecordedUsage = undefined;
    this.#consecutiveAutoCompactFailures = 0;
    this.#forkPinnedBoundary = false;
    this.#forkCompactBoundary = false;
  }

  /**
   * Create an isolated child context whose model-visible prefix is identical to
   * this context at the instant of the fork. Dynamic system sources are frozen
   * so later parent changes cannot rewrite the child's reusable prefix.
   */
  fork(options: ContextForkOptions = {}): ContextManager {
    const onCompactProgress = options.onCompactProgress ?? this.#onCompactProgress;
    const child = new ContextManager({
      system: resolveSystemSections(this.#system),
      ...(this.#flavor === undefined ? {} : { flavor: this.#flavor }),
      ...(this.#memory === undefined ? {} : { memory: this.#memory }),
      ...(this.#taskState === undefined ? {} : { taskState: this.#taskState }),
      compactAtChars: this.#compactAtChars,
      toolOutputChars: this.#toolOutputChars,
      compaction: this.#compaction,
      ...(this.#recentTurns === undefined ? {} : { recentTurns: this.#recentTurns }),
      summarize: options.summarize ?? this.#summarize,
      ...(onCompactProgress === undefined ? {} : { onCompactProgress }),
      hooks: options.hooks ?? this.#hooks,
    });
    child.#compact = this.#compact === undefined ? undefined : { ...this.#compact };
    child.#messages = this.#messages.map((message) => {
      const { cacheBreakpoint: _cacheBreakpoint, ...copy } = cloneForkMessage(message);
      return copy;
    });
    if (child.#messages.length > 0) {
      child.#messages[child.#messages.length - 1]!.cacheBreakpoint = true;
    } else if (child.#compact !== undefined) {
      child.#forkCompactBoundary = true;
    } else if (child.#pinnedMessages().length > 0) {
      child.#forkPinnedBoundary = true;
    }
    return child;
  }

  append(message: ModelMessage): void {
    this.appendMany([message]);
  }

  appendMany(messages: readonly ModelMessage[]): void {
    const prepared = messages.map((message) => message.role === "tool"
      ? { ...message, content: truncateToolOutput(message.content, this.#toolOutputChars) }
      : { ...message });
    this.#messages.push(...prepared);
  }

  updateTaskState(taskState: string | undefined): void {
    this.#taskState = taskState;
  }

  snapshot(): ContextSnapshot {
    return {
      ...(this.#compact === undefined ? {} : { compact: { ...this.#compact } }),
      messages: providerValidMessages(this.#messages),
    };
  }

  restore(snapshot: ContextSnapshot): void {
    const messages = providerValidMessages(snapshot.messages);
    const legacySummary = snapshot.summary?.role === "system" && snapshot.summary.content.startsWith("Conversation summary\n")
      ? snapshot.summary.content.slice("Conversation summary\n".length)
      : undefined;
    this.#compact = snapshot.compact === undefined
      ? (legacySummary === undefined ? undefined : { summary: legacySummary, compactedAt: new Date(0).toISOString() })
      : { ...snapshot.compact };
    this.#messages = messages.map((message) => message.role === "tool"
      ? { ...message, content: truncateToolOutput(message.content, this.#toolOutputChars) }
      : cloneMessage(message));
    this.#lastRecordedInputTokens = undefined;
    this.#estimatedTokensAtLastRecordedUsage = undefined;
    this.#consecutiveAutoCompactFailures = 0;
    this.#forkPinnedBoundary = false;
    this.#forkCompactBoundary = false;
  }

  messagesForModel(): ModelMessage[] {
    const pinned = this.#pinnedMessages();
    if (this.#forkPinnedBoundary && pinned.length > 0) pinned[pinned.length - 1]!.cacheBreakpoint = true;
    return [
      ...pinned,
      ...(this.#compact === undefined ? [] : [{
        role: "user" as const,
        content: compactContinuationMessage(this.#compact.summary),
        ...(this.#forkCompactBoundary ? { cacheBreakpoint: true } : {}),
      }]),
      ...this.#messages.map(cloneMessage),
    ];
  }

  estimatedTokens(): number {
    return estimateMessageTokens(this.messagesForModel());
  }

  needsCompaction(): boolean {
    if (modelVisibleText(this.messagesForModel()).length >= this.#compactAtChars) return true;
    return calculateContextPressure(this.#currentTokenUsage(), this.#compaction).shouldAutoCompact;
  }

  get lastRecordedInputTokens(): number | undefined { return this.#lastRecordedInputTokens; }
  get consecutiveAutoCompactFailures(): number { return this.#consecutiveAutoCompactFailures; }

  recordModelUsage(inputTokens: number): void {
    if (!Number.isFinite(inputTokens) || inputTokens < 0) return;
    this.#lastRecordedInputTokens = Math.ceil(inputTokens);
    this.#estimatedTokensAtLastRecordedUsage = this.estimatedTokens();
  }

  async prepareForModelCall(signal: AbortSignal = new AbortController().signal): Promise<boolean> {
    signal.throwIfAborted();
    if (!this.needsCompaction()) return false;
    const originalMessages = this.#messages;
    const originalRecordedUsage = this.#lastRecordedInputTokens;
    const originalEstimatedUsage = this.#estimatedTokensAtLastRecordedUsage;
    const rollbackMicrocompact = () => {
      this.#messages = originalMessages;
      this.#lastRecordedInputTokens = originalRecordedUsage;
      this.#estimatedTokensAtLastRecordedUsage = originalEstimatedUsage;
    };
    const microcompact = microcompactMessages(this.#messages, this.#compaction.microcompactKeepRecentToolResults);
    if (microcompact.changed) {
      this.#messages = microcompact.messages;
      this.#lastRecordedInputTokens = undefined;
      this.#estimatedTokensAtLastRecordedUsage = undefined;
    }
    if (!this.needsCompaction()) return microcompact.changed;
    if (this.#consecutiveAutoCompactFailures >= 3) {
      rollbackMicrocompact();
      return false;
    }
    try {
      const compacted = await this.#compactConversation(signal);
      if (compacted) {
        this.#consecutiveAutoCompactFailures = 0;
        return true;
      }
      rollbackMicrocompact();
      return false;
    } catch {
      rollbackMicrocompact();
      signal.throwIfAborted();
      this.#consecutiveAutoCompactFailures += 1;
      return false;
    }
  }

  async compact(
    signal: AbortSignal = new AbortController().signal,
    _reason: CompactReason = "manual",
  ): Promise<boolean> {
    const compacted = await this.#compactConversation(signal);
    if (compacted) this.#consecutiveAutoCompactFailures = 0;
    return compacted;
  }

  async #compactConversation(signal: AbortSignal): Promise<boolean> {
    signal.throwIfAborted();
    const splitAt = this.#recentTurns === undefined
      ? selectRecentStart(this.#messages, this.#compaction)
      : recentTurnStart(this.#messages, this.#recentTurns);
    const older = this.#messages.slice(0, splitAt);
    if (older.length === 0) return false;
    this.#lastCompactProgress = undefined;
    this.#reportCompactProgress(0);
    const inputs: ModelMessage[] = [
      ...(this.#compact === undefined ? [] : [{ role: "user", content: compactContinuationMessage(this.#compact.summary) } as const]),
      ...older,
    ];
    const before = await this.#hooks.emit({
      version: 1,
      type: "PreCompact",
      payload: { messageCount: inputs.length, estimatedTokens: estimateMessageTokens(inputs) },
    }, signal);
    signal.throwIfAborted();
    if (before.decision === "deny") return false;
    this.#reportCompactProgress(10);

    const rawSummary = await awaitWithSignal(
      this.#summarize(
        inputs.map((message) => ({ ...message })),
        signal,
        (percentage) => this.#reportCompactProgress(percentage),
      ),
      signal,
    );
    signal.throwIfAborted();
    this.#reportCompactProgress(80);
    const summary = formatCompactSummary(rawSummary);
    const nextCompact: CompactBoundary = { summary, compactedAt: new Date().toISOString() };
    const nextMessages = this.#messages.slice(splitAt);
    const nextVisible: ModelMessage[] = [
      ...this.#pinnedMessages(),
      { role: "user", content: compactContinuationMessage(nextCompact.summary) },
      ...nextMessages,
    ];

    await this.#hooks.emit({
      version: 1,
      type: "PostCompact",
      payload: { messageCount: inputs.length, estimatedTokens: estimateMessageTokens(nextVisible) },
    }, signal);
    signal.throwIfAborted();
    this.#reportCompactProgress(90);
    this.#compact = nextCompact;
    this.#messages = nextMessages.map(cloneMessage);
    this.#lastRecordedInputTokens = undefined;
    this.#estimatedTokensAtLastRecordedUsage = undefined;
    this.#reportCompactProgress(100);
    return true;
  }

  #reportCompactProgress(percentage: number): void {
    const normalized = Math.max(0, Math.min(100, Math.floor(percentage / 10) * 10));
    if (normalized === this.#lastCompactProgress) return;
    this.#lastCompactProgress = normalized;
    try { this.#onCompactProgress?.(normalized); }
    catch { /* Progress observers must not affect the compaction transaction. */ }
  }

  #currentTokenUsage(): number {
    const estimated = this.estimatedTokens();
    if (this.#lastRecordedInputTokens === undefined || this.#estimatedTokensAtLastRecordedUsage === undefined) return estimated;
    const appendedEstimate = Math.max(0, estimated - this.#estimatedTokensAtLastRecordedUsage);
    return Math.max(estimated, this.#lastRecordedInputTokens + appendedEstimate);
  }

  #pinnedMessages(): ModelMessage[] {
    return [
      ...resolveSystemSections(this.#system).map((content) => ({ role: "system" as const, content })),
      ...(this.#flavor === undefined ? [] : [{ role: "system" as const, content: `FLAVOR.md\n${this.#flavor}` }]),
      ...(this.#memory === undefined ? [] : [{ role: "system" as const, content: `Long-term memory\n${this.#memory}` }]),
      ...(this.#taskState === undefined ? [] : [{ role: "system" as const, content: `Task state\n${this.#taskState}` }]),
    ];
  }
}

function resolveSystemSections(source: SystemPromptSource): string[] {
  const resolved = typeof source === "function" ? source() : source;
  const sections = typeof resolved === "string" ? [resolved] : resolved;
  return sections.map((section) => section.trim()).filter((section) => section.length > 0);
}

function recentTurnStart(messages: readonly ModelMessage[], recentTurns: number): number {
  if (recentTurns === 0) return messages.length;
  let turns = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role !== "user") continue;
    turns += 1;
    if (turns === recentTurns) return index;
  }
  return 0;
}

function truncateToolOutput(content: string, limit: number): string {
  if (content.length <= limit) return content;
  const headLength = Math.ceil(limit / 2);
  const tailLength = Math.floor(limit / 2);
  return `${content.slice(0, headLength)}\n...[truncated; original length: ${content.length} characters]...\n${content.slice(content.length - tailLength)}`;
}

function modelVisibleText(messages: readonly ModelMessage[]): string {
  return messages.map(messageVisiblePart).join("\n");
}

function messageVisiblePart(message: ModelMessage): string {
  return `${message.content}${message.toolCalls === undefined ? "" : `\n${serializeForEstimate(message.toolCalls)}`}`;
}

function serializeForEstimate(value: unknown): string {
  const seen = new WeakSet<object>();
  return JSON.stringify(value, (_key, item: unknown) => {
    if (typeof item === "bigint") return `${item}n`;
    if (typeof item !== "object" || item === null) return item;
    if (seen.has(item)) return "[Circular]";
    seen.add(item);
    return item;
  }) ?? String(value);
}

function cloneMessage(message: ModelMessage): ModelMessage {
  return {
    ...message,
    ...(message.toolCalls === undefined ? {} : { toolCalls: message.toolCalls.map((call) => ({ ...call })) }),
  };
}

function cloneForkMessage(message: ModelMessage): ModelMessage {
  return {
    ...message,
    ...(message.toolCalls === undefined ? {} : {
      toolCalls: message.toolCalls.map((call) => ({
        ...call,
        input: structuredClone(call.input),
      })),
    }),
  };
}

function providerValidMessages(input: readonly ModelMessage[]): ModelMessage[] {
  const announced = new Set<string>();
  const availableResults = new Set(input.filter((message) => message.role === "tool" && message.toolCallId).map((message) => message.toolCallId!));
  const output: ModelMessage[] = [];
  for (const original of input) {
    if (original.role === "system") continue;
    if (original.role === "assistant" && original.toolCalls !== undefined) {
      const calls = original.toolCalls.filter((call) => call.id && call.name && availableResults.has(call.id));
      calls.forEach((call) => announced.add(call.id));
      if (!original.content && calls.length === 0) continue;
      output.push({ role: "assistant", content: original.content, ...(calls.length === 0 ? {} : { toolCalls: calls.map((call) => ({ ...call })) }) });
      continue;
    }
    if (original.role === "tool") {
      if (!original.toolCallId || !announced.has(original.toolCallId)) continue;
      output.push({ role: "tool", content: original.content, toolCallId: original.toolCallId });
      continue;
    }
    output.push(cloneMessage(original));
  }
  return output;
}
