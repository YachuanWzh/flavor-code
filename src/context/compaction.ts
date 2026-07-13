import type { ModelMessage } from "../models/types.js";

export interface CompactionPolicy {
  windowTokens: number;
  reservedOutputTokens: number;
  autoCompactBufferTokens: number;
  warningBufferTokens: number;
  blockingBufferTokens: number;
  microcompactKeepRecentToolResults: number;
  recentTokens: number;
  recentTextMessages: number;
  maxRecentTokens: number;
}

export interface ContextPressure {
  tokenUsage: number;
  effectiveWindowTokens: number;
  autoCompactThresholdTokens: number;
  warningThresholdTokens: number;
  blockingLimitTokens: number;
  percentLeft: number;
  isAboveWarningThreshold: boolean;
  shouldAutoCompact: boolean;
  isAtBlockingLimit: boolean;
}

export interface MicrocompactResult {
  messages: ModelMessage[];
  changed: boolean;
  clearedResults: number;
}

export const DEFAULT_COMPACTION_POLICY: CompactionPolicy = {
  windowTokens: 200_000,
  reservedOutputTokens: 20_000,
  autoCompactBufferTokens: 13_000,
  warningBufferTokens: 20_000,
  blockingBufferTokens: 3_000,
  microcompactKeepRecentToolResults: 5,
  recentTokens: 10_000,
  recentTextMessages: 5,
  maxRecentTokens: 40_000,
};

export const OLD_TOOL_RESULT_CLEARED = "[Old tool result content cleared]";

const COMPACTABLE_TOOLS = new Set([
  "read", "fileread", "shell", "bash", "grep", "glob", "websearch", "webfetch",
  "edit", "fileedit", "write", "filewrite", "applypatch",
]);

export function calculateContextPressure(tokenUsage: number, policy: CompactionPolicy): ContextPressure {
  const effectiveWindowTokens = Math.max(1, policy.windowTokens - policy.reservedOutputTokens);
  const autoCompactThresholdTokens = Math.max(1, effectiveWindowTokens - policy.autoCompactBufferTokens);
  const warningThresholdTokens = Math.max(1, autoCompactThresholdTokens - policy.warningBufferTokens);
  const blockingLimitTokens = Math.max(1, effectiveWindowTokens - policy.blockingBufferTokens);
  return {
    tokenUsage,
    effectiveWindowTokens,
    autoCompactThresholdTokens,
    warningThresholdTokens,
    blockingLimitTokens,
    percentLeft: Math.max(0, Math.round(((autoCompactThresholdTokens - tokenUsage) / autoCompactThresholdTokens) * 100)),
    isAboveWarningThreshold: tokenUsage >= warningThresholdTokens,
    shouldAutoCompact: tokenUsage >= autoCompactThresholdTokens,
    isAtBlockingLimit: tokenUsage >= blockingLimitTokens,
  };
}

export function groupMessagesByApiRound(messages: readonly ModelMessage[]): ModelMessage[][] {
  const groups: ModelMessage[][] = [];
  let current: ModelMessage[] = [];
  for (const message of messages) {
    if (message.role === "assistant" && current.length > 0) {
      groups.push(current);
      current = [cloneMessage(message)];
    } else {
      current.push(cloneMessage(message));
    }
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

export function selectRecentStart(messages: readonly ModelMessage[], policy: CompactionPolicy): number {
  if (messages.length === 0) return 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role !== "user") continue;
    const metrics = messageMetrics(messages.slice(index));
    if (metrics.tokens > policy.maxRecentTokens) continue;
    if (metrics.tokens >= policy.recentTokens && metrics.textMessages >= policy.recentTextMessages) return index;
  }

  const groups = groupMessagesByApiRound(messages);
  let tokens = 0;
  let textMessages = 0;
  let start = messages.length;
  for (let index = groups.length - 1; index >= 0; index -= 1) {
    const group = groups[index]!;
    const metrics = messageMetrics(group);
    if (tokens > 0 && tokens + metrics.tokens > policy.maxRecentTokens) break;
    tokens += metrics.tokens;
    textMessages += metrics.textMessages;
    start -= group.length;
    if (tokens >= policy.recentTokens && textMessages >= policy.recentTextMessages) break;
  }
  return Math.max(0, start);
}

export function microcompactMessages(messages: readonly ModelMessage[], keepRecent: number): MicrocompactResult {
  const callNames = new Map<string, string>();
  for (const message of messages) {
    for (const call of message.toolCalls ?? []) callNames.set(call.id, call.name.toLowerCase());
  }
  const compactableResults = messages
    .map((message, index) => ({ message, index }))
    .filter(({ message }) => message.role === "tool"
      && message.toolCallId !== undefined
      && COMPACTABLE_TOOLS.has(callNames.get(message.toolCallId) ?? "")
      && message.content !== OLD_TOOL_RESULT_CLEARED);
  const clearThrough = Math.max(0, compactableResults.length - Math.max(0, keepRecent));
  const clearIndexes = new Set(compactableResults.slice(0, clearThrough).map(({ index }) => index));
  const output = messages.map((message, index) => clearIndexes.has(index)
    ? { ...cloneMessage(message), content: OLD_TOOL_RESULT_CLEARED }
    : cloneMessage(message));
  return { messages: output, changed: clearIndexes.size > 0, clearedResults: clearIndexes.size };
}

export function buildCompactPrompt(): string {
  return `CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.

- Do NOT use Read, Shell, Grep, Glob, Edit, Write, or ANY other tool.
- You already have all context required in the conversation.
- Tool calls will be rejected and waste your only turn.
- Return an <analysis> drafting block followed by one <summary> block.

Create a detailed continuation summary of the conversation. Preserve exact user intent, technical decisions, current task state, and the information required to continue work without asking the user to repeat anything.

The <summary> must contain these sections:
1. Primary Request and Intent
2. Key Technical Concepts
3. Files and Code Sections
4. Errors and Fixes
5. Problem Solving
6. All User Messages
7. Pending Tasks
8. Current Work
9. Optional Next Step

For section 9, quote the most recent user request or recent work verbatim and make the next step directly follow it. Do not revive completed or unrelated work.`;
}

export function formatCompactSummary(value: string): string {
  let formatted = value.replace(/<analysis>[\s\S]*?<\/analysis>/gi, "").trim();
  const summary = formatted.match(/<summary>([\s\S]*?)<\/summary>/i);
  if (summary !== null) formatted = (summary[1] ?? "").trim();
  formatted = formatted.replace(/\n{3,}/g, "\n\n").trim();
  if (formatted.length === 0) throw new Error("Compact summary is empty");
  return formatted;
}

export function compactContinuationMessage(summary: string, transcriptPath?: string): string {
  let message = `This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.\n\n${summary}`;
  if (transcriptPath !== undefined) {
    message += `\n\nIf you need exact details from before compaction, read the full transcript at: ${transcriptPath}`;
  }
  return `${message}\n\nContinue the conversation from where it left off without asking the user further questions. Resume directly.`;
}

export function estimateMessageTokens(messages: readonly ModelMessage[]): number {
  return Math.ceil(messages.map(messageVisibleText).join("\n").length / 4);
}

function messageMetrics(messages: readonly ModelMessage[]): { tokens: number; textMessages: number } {
  return {
    tokens: estimateMessageTokens(messages),
    textMessages: messages.filter((message) => message.role !== "tool" && message.content.trim().length > 0).length,
  };
}

function messageVisibleText(message: ModelMessage): string {
  return `${message.content}${message.toolCalls === undefined ? "" : `\n${safeJson(message.toolCalls)}`}`;
}

function safeJson(value: unknown): string {
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
