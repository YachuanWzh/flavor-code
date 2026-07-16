import type { ToolResult } from "../tools/types.js";
import { redactErrorText } from "../utils/redact.js";

export const MAX_EVIDENCE_EVENTS = 24;
export const MAX_EVIDENCE_CHARS = 6_000;

const MAX_TOOL_NAME_CHARS = 80;
const MAX_INPUT_CHARS = 240;
const MAX_OUTPUT_CHARS = 240;
const MAX_DEPTH = 3;
const MAX_ARRAY_ITEMS = 8;
const MAX_OBJECT_KEYS = 12;
const KEEP_RECENT_EVENTS = 8;
const SENSITIVE_KEY = /api.?key|authorization|cookie|credential|password|secret|token/i;

export interface CompactEvidenceEvent {
  callId: string;
  toolName: string;
  status: "success" | "failure";
  input: string;
  repeatCount: number;
  sequence: number;
  outputKind?: string;
  outputChars?: number;
  outputExcerpt?: string;
  errorCode?: string;
  errorMessage?: string;
}

export interface EvidenceSnapshot {
  events: CompactEvidenceEvent[];
  omittedCount: number;
  foldedCount: number;
  text: string;
}

interface PendingCall {
  callId: string;
  toolName: string;
  input: string;
  sequence: number;
}

export class EvidenceLedger {
  readonly #pending = new Map<string, PendingCall>();
  readonly #events: CompactEvidenceEvent[] = [];
  #sequence = 0;
  #foldedCount = 0;

  recordCall(callId: string, toolName: string, input: unknown): void {
    this.#pending.set(callId, {
      callId: truncate(redactErrorText(callId), MAX_TOOL_NAME_CHARS),
      toolName: truncate(redactErrorText(toolName), MAX_TOOL_NAME_CHARS),
      input: summarize(input, MAX_INPUT_CHARS),
      sequence: this.#sequence++,
    });
  }

  recordResult(callId: string, toolName: string, result: ToolResult): void {
    const pending = this.#pending.get(callId);
    this.#pending.delete(callId);
    const event: CompactEvidenceEvent = {
      callId: pending?.callId ?? truncate(redactErrorText(callId), MAX_TOOL_NAME_CHARS),
      toolName: pending?.toolName ?? truncate(redactErrorText(toolName), MAX_TOOL_NAME_CHARS),
      status: result.ok ? "success" : "failure",
      input: pending?.input ?? "[input unavailable]",
      repeatCount: 1,
      sequence: pending?.sequence ?? this.#sequence++,
      ...(result.ok ? outputFields(result.output) : errorFields(result)),
    };

    const previous = this.#events.at(-1);
    if (previous !== undefined && foldKey(previous) === foldKey(event)) {
      previous.repeatCount += 1;
      this.#foldedCount += 1;
      return;
    }
    this.#events.push(event);
  }

  snapshot(): EvidenceSnapshot {
    if (this.#events.length === 0) {
      const empty = { events: [], omittedCount: 0, foldedCount: this.#foldedCount };
      return { ...empty, text: JSON.stringify(empty) };
    }

    const selectedIndexes = new Set<number>();
    for (let index = Math.max(0, this.#events.length - KEEP_RECENT_EVENTS); index < this.#events.length; index += 1) {
      selectedIndexes.add(index);
    }
    const priorityOrder = this.#events
      .map((event, index) => ({ index, priority: retentionPriority(event), sequence: event.sequence }))
      .sort((left, right) => right.priority - left.priority || right.sequence - left.sequence);
    for (const candidate of priorityOrder) {
      if (selectedIndexes.size >= MAX_EVIDENCE_EVENTS) break;
      selectedIndexes.add(candidate.index);
    }

    let events = [...selectedIndexes]
      .sort((left, right) => this.#events[left]!.sequence - this.#events[right]!.sequence)
      .map((index) => ({ ...this.#events[index]! }));
    let omittedCount = this.#events.length - events.length;
    let text = serializeSnapshot(events, omittedCount, this.#foldedCount);

    while (text.length > MAX_EVIDENCE_CHARS && events.length > 1) {
      const removable = events
        .map((event, index) => ({ index, priority: retentionPriority(event), sequence: event.sequence }))
        .sort((left, right) => left.priority - right.priority || left.sequence - right.sequence)[0]!;
      events.splice(removable.index, 1);
      omittedCount += 1;
      text = serializeSnapshot(events, omittedCount, this.#foldedCount);
    }

    return { events, omittedCount, foldedCount: this.#foldedCount, text };
  }

  reset(): void {
    this.#pending.clear();
    this.#events.length = 0;
    this.#sequence = 0;
    this.#foldedCount = 0;
  }
}

function outputFields(output: unknown): Pick<
  CompactEvidenceEvent,
  "outputKind" | "outputChars" | "outputExcerpt"
> {
  const serialized = summarize(output, Number.MAX_SAFE_INTEGER);
  return {
    outputKind: valueKind(output),
    outputChars: serialized.length,
    outputExcerpt: truncate(serialized, MAX_OUTPUT_CHARS),
  };
}

function errorFields(result: ToolResult): Pick<CompactEvidenceEvent, "errorCode" | "errorMessage"> {
  return {
    errorCode: truncate(redactErrorText(result.error?.code ?? "unknown"), 80),
    errorMessage: truncate(redactErrorText(result.error?.message ?? "unknown error"), MAX_OUTPUT_CHARS),
  };
}

function foldKey(event: CompactEvidenceEvent): string {
  return JSON.stringify({
    toolName: event.toolName,
    status: event.status,
    input: event.input,
    outputKind: event.outputKind,
    outputExcerpt: event.outputExcerpt,
    errorCode: event.errorCode,
    errorMessage: event.errorMessage,
  });
}

function retentionPriority(event: CompactEvidenceEvent): number {
  const searchable = `${event.toolName} ${event.input}`.toLowerCase();
  if (/\b(test|verify|verification|typecheck|build|lint)\b/.test(searchable)) return 50;
  if (/\b(write|edit|patch|apply)\b/.test(searchable)) return 40;
  if (event.status === "failure") return 30;
  return 10;
}

function serializeSnapshot(
  events: readonly CompactEvidenceEvent[],
  omittedCount: number,
  foldedCount: number,
): string {
  return JSON.stringify({ omittedCount, foldedCount, events });
}

function summarize(value: unknown, maxChars: number): string {
  const sanitized = sanitize(value, 0, new WeakSet<object>());
  let serialized: string;
  try {
    serialized = typeof sanitized === "string" ? sanitized : JSON.stringify(sanitized) ?? String(sanitized);
  } catch {
    serialized = "[unserializable]";
  }
  return truncate(redactErrorText(serialized), maxChars);
}

function sanitize(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (typeof value === "string") return truncate(redactErrorText(value), MAX_OUTPUT_CHARS * 2);
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (value === undefined) return "[undefined]";
  if (typeof value === "bigint" || typeof value === "symbol" || typeof value === "function") {
    return `[${typeof value}]`;
  }
  if (depth >= MAX_DEPTH) return "[depth-limited]";
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ARRAY_ITEMS).map((item) => sanitize(item, depth + 1, seen));
    if (value.length > MAX_ARRAY_ITEMS) items.push(`[${value.length - MAX_ARRAY_ITEMS} more items]`);
    return items;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .slice(0, MAX_OBJECT_KEYS)
    .map(([key, item]) => [
      truncate(redactErrorText(key), 80),
      SENSITIVE_KEY.test(key) ? "[redacted]" : sanitize(item, depth + 1, seen),
    ]);
  if (Object.keys(value as Record<string, unknown>).length > MAX_OBJECT_KEYS) {
    entries.push(["[omittedKeys]", "true"]);
  }
  return Object.fromEntries(entries);
}

function valueKind(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 14))}...[truncated]`;
}
