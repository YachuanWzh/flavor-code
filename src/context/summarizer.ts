import type { ModelRegistry } from "../models/registry.js";
import type { ModelMessage, ProviderError } from "../models/types.js";
import { buildCompactPrompt, formatCompactSummary, groupMessagesByApiRound } from "./compaction.js";

export interface ModelSummarizerOptions {
  registry: ModelRegistry;
  modelId(): string;
  messages: readonly ModelMessage[];
  signal?: AbortSignal;
  maxPromptTooLongAttempts?: number;
  onProgress?: (percentage: number) => void;
  onUsage?: (usage: { inputTokens: number; outputTokens: number }) => void;
}

export async function summarizeWithModel(options: ModelSummarizerOptions): Promise<string> {
  options.signal?.throwIfAborted();
  let groups = groupMessagesByApiRound(options.messages);
  // Default to enough logarithmic reductions to reach one API round. This
  // removes the arbitrary three-attempt ceiling without retrying once per
  // historical round when a large context must be reduced substantially.
  const maxAttempts = options.maxPromptTooLongAttempts
    ?? Math.max(1, Math.ceil(Math.log2(Math.max(1, groups.length))) + 1);
  if (!Number.isInteger(maxAttempts) || maxAttempts <= 0) throw new Error("maxPromptTooLongAttempts must be positive");
  let lastOverflow: ProviderError | undefined;
  let progress = 20;
  reportProgress(options.onProgress, progress);

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    options.signal?.throwIfAborted();
    const candidate = groups.flat();
    const { adapter, model } = options.registry.get(options.modelId());
    let text = "";
    let completed = false;
    let terminalError: ProviderError | undefined;
    let usage: { inputTokens: number; outputTokens: number } | undefined;
    for await (const event of adapter.stream({
      model,
      messages: [...candidate, { role: "user", content: buildCompactPrompt() }],
      tools: [],
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    })) {
      if (event.type === "text") {
        text += event.text;
        progress = Math.min(70, progress + 10);
        reportProgress(options.onProgress, progress);
      }
      else if (event.type === "usage") usage = { inputTokens: event.inputTokens, outputTokens: event.outputTokens };
      else if (event.type === "error") { terminalError = event.error; break; }
      else if (event.type === "done") { usage = event.usage; completed = true; break; }
    }
    if (usage !== undefined) reportUsage(options.onUsage, usage);

    if (terminalError === undefined) {
      if (!completed) throw new Error("Compact summary stream ended without completion");
      reportProgress(options.onProgress, 80);
      return formatCompactSummary(text);
    }
    if (terminalError.code !== "context_overflow") throw terminalError;
    lastOverflow = terminalError;
    if (attempt >= maxAttempts || groups.length <= 1) throw terminalError;
    groups = groups.slice(Math.max(1, Math.floor(groups.length / 2)));
  }

  throw lastOverflow ?? new Error("Compact summary failed");
}

function reportUsage(
  callback: ModelSummarizerOptions["onUsage"], usage: { inputTokens: number; outputTokens: number },
): void {
  try { callback?.(usage); }
  catch { /* Usage observers must not affect summarization. */ }
}

function reportProgress(callback: ModelSummarizerOptions["onProgress"], percentage: number): void {
  try { callback?.(percentage); }
  catch { /* Progress observers must not affect summarization. */ }
}
