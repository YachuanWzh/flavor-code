import type { ModelRegistry } from "../models/registry.js";
import type { ModelMessage, ProviderError } from "../models/types.js";
import { buildCompactPrompt, formatCompactSummary, groupMessagesByApiRound } from "./compaction.js";

export interface ModelSummarizerOptions {
  registry: ModelRegistry;
  modelId(): string;
  messages: readonly ModelMessage[];
  signal?: AbortSignal;
  maxPromptTooLongAttempts?: number;
}

export async function summarizeWithModel(options: ModelSummarizerOptions): Promise<string> {
  const maxAttempts = options.maxPromptTooLongAttempts ?? 3;
  if (!Number.isInteger(maxAttempts) || maxAttempts <= 0) throw new Error("maxPromptTooLongAttempts must be positive");
  options.signal?.throwIfAborted();
  let groups = groupMessagesByApiRound(options.messages);
  let lastOverflow: ProviderError | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    options.signal?.throwIfAborted();
    const candidate = groups.flat();
    const { adapter, model } = options.registry.get(options.modelId());
    let text = "";
    let completed = false;
    let terminalError: ProviderError | undefined;
    for await (const event of adapter.stream({
      model,
      messages: [...candidate, { role: "user", content: buildCompactPrompt() }],
      tools: [],
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    })) {
      if (event.type === "text") text += event.text;
      else if (event.type === "error") { terminalError = event.error; break; }
      else if (event.type === "done") { completed = true; break; }
    }

    if (terminalError === undefined) {
      if (!completed) throw new Error("Compact summary stream ended without completion");
      return formatCompactSummary(text);
    }
    if (terminalError.code !== "context_overflow") throw terminalError;
    lastOverflow = terminalError;
    if (attempt >= maxAttempts || groups.length <= 1) throw terminalError;
    groups = groups.slice(1);
  }

  throw lastOverflow ?? new Error("Compact summary failed");
}
