import type { ContextManager } from "../context/manager.js";
import type { HookBus } from "../hooks/bus.js";
import type { ModelRegistry } from "../models/registry.js";
import { normalizeProviderError, type ModelMessage, type ModelTool } from "../models/types.js";
import type { ToolRuntime } from "../tools/runtime.js";
import type { ToolResult } from "../tools/types.js";
import type { AgentError, AgentEvent, AgentRunRequest } from "./types.js";

const DEFAULT_MAX_ITERATIONS = 40;
const DEFAULT_MODEL_ATTEMPTS = 3;
const FALLBACK_MODEL_ATTEMPTS = 2;
const RETRY_BASE_DELAY_MS = 1_000;
const RECOVERABLE_MODEL_ERRORS = new Set<AgentError["code"]>([
  "network", "rate_limit", "unknown", "incomplete_stream",
]);

function envMaxIterations(): number | undefined {
  const raw = process.env["FLAVOR_MAX_ITERATIONS"];
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) return undefined;
  return parsed;
}

export interface AgentLoopOptions {
  registry: ModelRegistry;
  modelId: string;
  fallbackModelId?: string;
  context: ContextManager;
  runtime: ToolRuntime;
  hooks: HookBus;
  tools: readonly ModelTool[];
  maxIterations?: number;
  softLimitFactor?: number;
  extendIterations?: number;
  maxExtensions?: number;
  hasActiveProgress?(): boolean;
  agent?: "main" | "subagent";
}

export class AgentLoop {
  readonly #options: Required<Pick<AgentLoopOptions, "maxIterations" | "softLimitFactor" | "extendIterations" | "maxExtensions" | "agent">> & Omit<AgentLoopOptions, "maxIterations" | "softLimitFactor" | "extendIterations" | "maxExtensions" | "agent">;

  constructor(options: AgentLoopOptions) {
    const envOverride = envMaxIterations();
    const maxIterations = envOverride ?? options.maxIterations ?? DEFAULT_MAX_ITERATIONS;
    if (maxIterations <= 0 || !Number.isInteger(maxIterations)) throw new Error("maxIterations must be a positive integer");
    const softLimitFactor = options.softLimitFactor ?? 0.8;
    if (softLimitFactor <= 0 || softLimitFactor > 1) throw new Error("softLimitFactor must be in (0, 1]");
    const extendIterations = options.extendIterations ?? 20;
    if (extendIterations <= 0 || !Number.isInteger(extendIterations)) throw new Error("extendIterations must be a positive integer");
    const maxExtensions = options.maxExtensions ?? 3;
    if (maxExtensions < 0 || !Number.isInteger(maxExtensions)) throw new Error("maxExtensions must be a non-negative integer");
    this.#options = {
      ...options,
      maxIterations,
      softLimitFactor,
      extendIterations,
      maxExtensions,
      agent: options.agent ?? "main",
    };
  }

  get modelId(): string { return this.#options.modelId; }

  setModel(modelId: string): void {
    this.#options.registry.get(modelId);
    this.#options.modelId = modelId;
  }

  setFallbackModel(modelId: string): void {
    this.#options.registry.get(modelId);
    this.#options.fallbackModelId = modelId;
  }

  async *run(request: AgentRunRequest): AsyncIterable<AgentEvent> {
    this.#options.context.append({ role: "user", content: request.prompt });
    let totalInputTokens = 0;
    let totalOutputTokens = 0;

    let maxIterations = this.#options.maxIterations;
    let extensions = 0;
    let warned = false;

    let iteration = 0;
    while (true) {
      if (request.signal?.aborted) {
        yield { type: "error", error: { code: "cancelled", message: abortMessage(request.signal) } };
        return;
      }

      // 方案3: soft limit warning
      const softLimit = Math.floor(maxIterations * this.#options.softLimitFactor);
      if (!warned && iteration >= softLimit) {
        warned = true;
        const remaining = maxIterations - iteration;
        yield {
          type: "warning",
          message: `Approaching iteration limit: ${iteration}/${maxIterations} rounds used. ${remaining} rounds remaining before automatic circuit breaker.`,
        };
      }

      // 方案4+方案3: hard limit with progress-aware auto-extension
      if (iteration >= maxIterations) {
        if (this.#options.hasActiveProgress?.() && extensions < this.#options.maxExtensions) {
          const previous = maxIterations;
          maxIterations += this.#options.extendIterations;
          extensions += 1;
          yield {
            type: "limit_reached",
            iteration,
            maxIterations: previous,
            extended: true,
          };
          yield {
            type: "warning",
            message: `Iteration limit ${previous} reached but task progress is active. Auto-extending by ${this.#options.extendIterations} rounds (extension ${extensions}/${this.#options.maxExtensions}).`,
          };
          continue;
        }
        yield {
          type: "error",
          error: { code: "iteration_limit", message: `Agent exceeded the ${maxIterations} iteration limit` },
        };
        return;
      }

      try {
        if (await this.#options.context.prepareForModelCall(request.signal)) yield { type: "compacted" };
      } catch (error) {
        yield { type: "error", error: normalizeProviderError(error) };
        return;
      }

      let assistantText = "";
      const toolCalls: Array<{ id: string; name: string; input: unknown }> = [];
      let completed = false;
      let reactiveRetried = false;
      let attempt = 1;
      const maxAttempts = DEFAULT_MODEL_ATTEMPTS
        + (this.#options.fallbackModelId === undefined ? 0 : FALLBACK_MODEL_ATTEMPTS);
      while (true) {
        const attemptedModelId = attempt <= DEFAULT_MODEL_ATTEMPTS
          ? this.#options.modelId
          : this.#options.fallbackModelId!;
        let resolved: ReturnType<ModelRegistry["get"]>;
        try { resolved = this.#options.registry.get(attemptedModelId); }
        catch (error) {
          yield { type: "error", error: normalizeProviderError(error) };
          return;
        }
        const { adapter, model } = resolved;
        const modelRequest = {
          model,
          messages: [
            ...this.#options.context.messagesForModel(),
            ...(request.additionalContext ? [{ role: "system" as const, content: request.additionalContext }] : []),
          ],
          tools: [...this.#options.tools],
          ...(request.signal === undefined ? {} : { signal: request.signal }),
        };
        let before;
        try {
          before = await this.#options.hooks.emit({
            version: 1,
            type: "BeforeModelCall",
            payload: { modelId: attemptedModelId, iteration, messageCount: modelRequest.messages.length, attempt, maxAttempts },
          });
        } catch (error) {
          yield { type: "error", error: normalizeProviderError(error) };
          return;
        }
        if (before.decision === "deny") {
          yield { type: "error", error: { code: "cancelled", message: before.reason ?? "Model call denied by hook" } };
          return;
        }

        assistantText = "";
        toolCalls.length = 0;
        completed = false;
        let terminalError: AgentError | undefined;
        let providerError = false;
        let usage: { inputTokens: number; outputTokens: number } | undefined;
        try {
          for await (const event of adapter.stream(modelRequest)) {
            if (event.type === "text") {
              assistantText += event.text;
              yield event;
            } else if (event.type === "tool-call") {
              toolCalls.push(event);
            } else if (event.type === "usage") {
              usage = { inputTokens: event.inputTokens, outputTokens: event.outputTokens };
            } else if (event.type === "error") {
              terminalError = event.error;
              break;
            } else {
              completed = true;
              usage = event.usage;
              break;
            }
          }
        } catch (error) {
          terminalError = normalizeProviderError(error);
        } finally {
          if (!completed && terminalError === undefined) {
            terminalError = { code: "incomplete_stream", message: "Provider stream ended without a done or error event" };
          }
          providerError = terminalError !== undefined;
          try {
            await this.#options.hooks.emit({
              version: 1,
              type: "AfterModelCall",
              payload: {
                modelId: attemptedModelId,
                iteration,
                attempt,
                maxAttempts,
                completed,
                agent: this.#options.agent,
                providerError,
                ...(terminalError === undefined ? {} : {
                  errorCode: terminalError.code,
                  errorMessage: terminalError.message,
                }),
              },
            });
          } catch (error) {
            if (terminalError === undefined) {
              terminalError = normalizeProviderError(error);
              providerError = false;
            }
          }
        }

        if (usage !== undefined) {
          this.#options.context.recordModelUsage(usage.inputTokens);
          totalInputTokens += usage.inputTokens;
          totalOutputTokens += usage.outputTokens;
          yield { type: "usage", ...usage, totalInputTokens, totalOutputTokens };
        }
        const providerProducedOutput = assistantText.length > 0 || toolCalls.length > 0;
        if (
          terminalError?.code === "context_overflow"
          && !reactiveRetried
          && !providerProducedOutput
          && attempt < maxAttempts
        ) {
          let compacted = false;
          try { compacted = await this.#options.context.compact(request.signal, "reactive"); }
          catch {
            if (request.signal?.aborted) {
              yield { type: "error", error: { code: "cancelled", message: abortMessage(request.signal) } };
              return;
            }
          }
          if (compacted) {
            reactiveRetried = true;
            attempt += 1;
            yield { type: "compacted" };
            continue;
          }
        }
        if (
          terminalError !== undefined
          && providerError
          && !providerProducedOutput
          && RECOVERABLE_MODEL_ERRORS.has(terminalError.code)
          && attempt < maxAttempts
        ) {
          const nextAttempt = attempt + 1;
          const delayMs = RETRY_BASE_DELAY_MS * (2 ** (attempt - 1));
          yield { type: "model-retry", attempt: nextAttempt, maxAttempts, delayMs };
          try {
            await waitForRetry(delayMs, request.signal);
          } catch {
            yield { type: "error", error: { code: "cancelled", message: request.signal === undefined
              ? "Agent run cancelled"
              : abortMessage(request.signal) } };
            return;
          }
          attempt = nextAttempt;
          continue;
        }
        if (terminalError !== undefined) {
          yield { type: "error", error: terminalError };
          return;
        }
        break;
      }

      if (toolCalls.length === 0 && assistantText) {
        this.#options.context.append({
          role: "assistant",
          content: assistantText,
        });
      }
      if (toolCalls.length === 0) {
        yield { type: "done", usage: { inputTokens: totalInputTokens, outputTokens: totalOutputTokens } };
        return;
      }

      const stagedMessages: ModelMessage[] = [];
      const stagedResults: Array<{ call: (typeof toolCalls)[number]; result: ToolResult }> = [];
      let turnError: ReturnType<typeof normalizeProviderError> | undefined;
      for (let index = 0; index < toolCalls.length; index += 1) {
        const call = toolCalls[index]!;
        if (request.signal?.aborted) {
          turnError = { code: "cancelled", message: abortMessage(request.signal) };
          stageSyntheticResults(toolCalls, index, turnError, stagedMessages);
          break;
        }
        const label = this.#options.runtime.label(call);
        const hint = this.#options.runtime.hint(call);
        yield { type: "tool-start", id: call.id, name: call.name, input: call.input, ...(label === undefined ? {} : { label }), ...(hint === undefined ? {} : { hint }) };
        const result = await this.#options.runtime.execute(call, { agent: this.#options.agent, ...(request.signal === undefined ? {} : { signal: request.signal }) });
        if (request.signal?.aborted) {
          turnError = { code: "cancelled", message: abortMessage(request.signal) };
          stagedResults.push({ call, result: { ok: false, error: turnError } });
          stageSyntheticResults(toolCalls, index, turnError, stagedMessages);
          break;
        }
        try {
          stagedMessages.push(toolResultMessage(call.id, result));
          stagedResults.push({ call, result });
        } catch (error) {
          turnError = normalizeProviderError(error);
          stageSyntheticResults(toolCalls, index, {
            code: "serialization_error",
            message: turnError.message,
          }, stagedMessages);
          break;
        }
      }
      const assistantMessage: ModelMessage = {
        role: "assistant",
        content: assistantText,
        toolCalls: toolCalls.map(({ id, name, input }) => ({ id, name, input })),
      };
      this.#options.context.appendMany([assistantMessage, ...stagedMessages]);
      for (const { call, result } of stagedResults) {
        const endLabel = this.#options.runtime.label(call);
        const endHint = this.#options.runtime.hint(call);
        yield { type: "tool-end", id: call.id, name: call.name, result, ...(endLabel === undefined ? {} : { label: endLabel }), ...(endHint === undefined ? {} : { hint: endHint }) };
      }
      if (turnError !== undefined) {
        yield { type: "error", error: turnError };
        return;
      }

      iteration += 1;
    }
  }
}

function toolResultMessage(toolCallId: string, result: ToolResult): ModelMessage {
  return { role: "tool", toolCallId, content: JSON.stringify(result.ok ? result.output : { error: result.error }) ?? "null" };
}

function abortMessage(signal: AbortSignal): string {
  return signal.reason instanceof Error ? signal.reason.message : "Agent run cancelled";
}

function waitForRetry(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason);
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function stageSyntheticResults(
  calls: readonly { id: string; name: string; input: unknown }[],
  start: number,
  error: { code: string; message: string },
  messages: ModelMessage[],
): void {
  for (let index = start; index < calls.length; index += 1) {
    const call = calls[index]!;
    const result: ToolResult = index === start
      ? { ok: false, error }
      : { ok: false, error: { code: "skipped", message: `Skipped after ${error.code}: ${error.message}` } };
    messages.push(toolResultMessage(call.id, result));
  }
}
