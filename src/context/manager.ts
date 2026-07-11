import type { HookBus } from "../hooks/bus.js";
import type { ModelMessage } from "../models/types.js";

export interface ContextManagerOptions {
  system: string;
  flavor?: string;
  taskState?: string;
  compactAtChars: number;
  toolOutputChars: number;
  recentTurns?: number;
  /** @deprecated Prefer recentTurns. */
  recentMessages?: number;
  summarize(messages: readonly ModelMessage[], signal: AbortSignal): Promise<string>;
  hooks: HookBus;
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export class ContextManager {
  readonly #system: string;
  readonly #flavor: string | undefined;
  readonly #compactAtChars: number;
  readonly #toolOutputChars: number;
  readonly #recentTurns: number;
  readonly #summarize: ContextManagerOptions["summarize"];
  readonly #hooks: HookBus;
  #taskState: string | undefined;
  #summary: ModelMessage | undefined;
  #messages: ModelMessage[] = [];

  constructor(options: ContextManagerOptions) {
    if (options.compactAtChars <= 0) throw new Error("compactAtChars must be positive");
    if (options.toolOutputChars <= 0) throw new Error("toolOutputChars must be positive");
    const recentTurns = options.recentTurns ?? options.recentMessages ?? 3;
    if (recentTurns < 0) throw new Error("recentTurns must not be negative");
    this.#system = options.system;
    this.#flavor = options.flavor;
    this.#taskState = options.taskState;
    this.#compactAtChars = options.compactAtChars;
    this.#toolOutputChars = options.toolOutputChars;
    this.#recentTurns = recentTurns;
    this.#summarize = options.summarize;
    this.#hooks = options.hooks;
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

  messagesForModel(): ModelMessage[] {
    return [...this.#pinnedMessages(), ...(this.#summary ? [{ ...this.#summary }] : []), ...this.#messages.map((message) => ({ ...message }))];
  }

  estimatedTokens(): number {
    return estimateTokens(modelVisibleText(this.messagesForModel()));
  }

  needsCompaction(): boolean {
    return modelVisibleText(this.messagesForModel()).length >= this.#compactAtChars;
  }

  async compact(signal: AbortSignal = new AbortController().signal): Promise<boolean> {
    signal.throwIfAborted();
    if (!this.needsCompaction()) return false;
    const splitAt = recentTurnStart(this.#messages, this.#recentTurns);
    const older = this.#messages.slice(0, splitAt);
    if (older.length === 0) return false;
    const inputs = [...(this.#summary ? [this.#summary] : []), ...older];
    const before = await this.#hooks.emit({
      version: 1,
      type: "PreCompact",
      payload: { messageCount: inputs.length, estimatedTokens: estimateMessageTokens(inputs) },
    }, signal);
    signal.throwIfAborted();
    if (before.decision === "deny") return false;

    const summary = await awaitWithSignal(
      this.#summarize(inputs.map((message) => ({ ...message })), signal),
      signal,
    );
    signal.throwIfAborted();
    const nextSummary: ModelMessage = { role: "system", content: `Conversation summary\n${summary}` };
    const nextMessages = this.#messages.slice(splitAt);
    const nextVisible = [...this.#pinnedMessages(), nextSummary, ...nextMessages];

    await this.#hooks.emit({
      version: 1,
      type: "PostCompact",
      payload: { messageCount: inputs.length, estimatedTokens: estimateTokens(modelVisibleText(nextVisible)) },
    }, signal);
    signal.throwIfAborted();
    this.#summary = nextSummary;
    this.#messages = nextMessages;
    return true;
  }

  #pinnedMessages(): ModelMessage[] {
    return [
      { role: "system", content: this.#system },
      ...(this.#flavor === undefined ? [] : [{ role: "system" as const, content: `FLAVOR.md\n${this.#flavor}` }]),
      ...(this.#taskState === undefined ? [] : [{ role: "system" as const, content: `Task state\n${this.#taskState}` }]),
    ];
  }
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

function estimateMessageTokens(messages: readonly ModelMessage[]): number {
  return estimateTokens(modelVisibleText(messages));
}

function modelVisibleText(messages: readonly ModelMessage[]): string {
  return messages.map(messageVisiblePart).join("\n");
}

function messageVisiblePart(message: ModelMessage): string {
  return `${message.content}${message.toolCalls === undefined ? "" : `\n${serializeForEstimate(message.toolCalls)}`}`;
}

function awaitWithSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => { signal.removeEventListener("abort", onAbort); resolve(value); },
      (error: unknown) => { signal.removeEventListener("abort", onAbort); reject(error); },
    );
  });
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
