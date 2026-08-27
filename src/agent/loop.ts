import type { ContextManager } from "../context/manager.js";
import type { HallucinationGuard } from "../hallucination/guard.js";
import type { HookBus } from "../hooks/bus.js";
import type { ModelRegistry } from "../models/registry.js";
import { withStructuredOutput } from "../models/structured.js";
import { normalizeProviderError, type ModelMessage, type ModelThinkingBlock, type ModelTool, type ProviderError } from "../models/types.js";
import type { ToolRuntime } from "../tools/runtime.js";
import type { ToolResult } from "../tools/types.js";
import type { AgentError, AgentEvent, AgentRunRequest, TurnDeliverable } from "./types.js";

const DEFAULT_MAX_ITERATIONS = 40;
const D2C_MAX_ITERATION_EXTENSIONS = 10;
const DEFAULT_MODEL_ATTEMPTS = 3;
const FALLBACK_MODEL_ATTEMPTS = 2;
const RETRY_BASE_DELAY_MS = 1_000;
const RECOVERABLE_MODEL_ERRORS = new Set<AgentError["code"]>([
  "network", "rate_limit", "unknown", "incomplete_stream", "empty_response",
]);

type CollectedToolCall =
  | { kind: "valid"; id: string; name: string; input: unknown }
  | { kind: "invalid"; id: string; name: string; rawInput: string; error: ProviderError };

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
  ownerId?: string;
  hallucinationGuard?: HallucinationGuard;
  modelJournal?: {
    start(input: { agent: "main" | "subagent"; model: string; iteration: number; attempt: number; messages: readonly ModelMessage[] }): string;
    complete(id: string, completed: boolean, error?: string): void;
  };
}

export class AgentLoop {
  readonly #options: Required<Pick<AgentLoopOptions, "maxIterations" | "softLimitFactor" | "extendIterations" | "maxExtensions" | "agent">> & Omit<AgentLoopOptions, "maxIterations" | "softLimitFactor" | "extendIterations" | "maxExtensions" | "agent">;
  #iterationLimitMode: "standard" | "d2c" = "standard";

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
  get iterationLimitMode(): "standard" | "d2c" { return this.#iterationLimitMode; }

  setModel(modelId: string): void {
    this.#options.registry.get(modelId);
    this.#options.modelId = modelId;
  }

  setFallbackModel(modelId: string): void {
    this.#options.registry.get(modelId);
    this.#options.fallbackModelId = modelId;
  }

  /** D2C keeps a hard cap, but may automatically expand it up to ten times. */
  setIterationLimitMode(mode: "standard" | "d2c"): void {
    this.#iterationLimitMode = mode;
  }

  async *run(request: AgentRunRequest): AsyncIterable<AgentEvent> {
    const transientId = request.additionalContext === undefined
      ? undefined
      : this.#options.context.beginTransientSystem(request.additionalContext);
    try { yield* this.#runInternal(request); }
    finally { if (transientId !== undefined) this.#options.context.endTransientSystem(transientId); }
  }

  async *#runInternal(request: AgentRunRequest): AsyncIterable<AgentEvent> {
    // Dynamic context is sampled at a provider boundary before the user turn.
    // This keeps the epoch prefix byte-stable while preserving chronological
    // source updates in the durable conversation.
    this.#options.context.refreshContextSources();
    this.#options.context.append(request.initialUserMessage ?? { role: "user", content: request.prompt });
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalCacheReadTokens = 0;
    let totalCacheCreationTokens = 0;
    let hasCacheData = false;
    let accumulatedText = "";
    let modelInvocation = 0;
    const deliverables = new Map<string, TurnDeliverable>();

    let maxIterations = this.#options.maxIterations;
    const iterationLimitMode = this.#iterationLimitMode;
    const maxExtensions = iterationLimitMode === "d2c"
      ? D2C_MAX_ITERATION_EXTENSIONS
      : this.#options.maxExtensions;
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
          message: iterationLimitMode === "d2c"
            ? `Approaching D2C base iteration limit: ${iteration}/${maxIterations} rounds used. ${remaining} rounds remain before automatic expansion (up to ${maxExtensions} expansions).`
            : `Approaching iteration limit: ${iteration}/${maxIterations} rounds used. ${remaining} rounds remaining before automatic circuit breaker.`,
        };
      }

      // 方案4+方案3: hard limit with progress-aware auto-extension
      if (iteration >= maxIterations) {
        const canAutoExtend = extensions < maxExtensions
          && (iterationLimitMode === "d2c" || this.#options.hasActiveProgress?.() === true);
        if (canAutoExtend) {
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
            message: iterationLimitMode === "d2c"
              ? `D2C iteration limit ${previous} reached. Auto-expanding by ${this.#options.extendIterations} rounds (expansion ${extensions}/${maxExtensions}).`
              : `Iteration limit ${previous} reached but task progress is active. Auto-extending by ${this.#options.extendIterations} rounds (extension ${extensions}/${maxExtensions}).`,
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
      const collectedToolCalls: CollectedToolCall[] = [];
      /** Sealed provider thinking blocks of the current turn, echoed back on the next request. */
      const collectedThinking: ModelThinkingBlock[] = [];
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
          messages: this.#options.context.messagesForModel(),
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
        collectedToolCalls.length = 0;
        collectedThinking.length = 0;
        completed = false;
        let terminalError: AgentError | undefined;
        let providerError = false;
        let usage: {
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens?: number;
      cacheCreationTokens?: number;
    } | undefined;
        const modelCallId = String(++modelInvocation);
        const journalModelId = this.#options.modelJournal?.start({
          agent: this.#options.agent, model: attemptedModelId, iteration, attempt, messages: modelRequest.messages,
        });
        const modelStartedAt = Date.now();
        yield { type: "model-start", id: modelCallId };
        try {
          for await (const event of adapter.stream(modelRequest)) {
            if (event.type === "text") {
              assistantText += event.text;
              accumulatedText += event.text;
              yield event;
            } else if (event.type === "thinking") {
              yield event;
            } else if (event.type === "thinking-block") {
              collectedThinking.push({ text: event.text, ...(event.signature === undefined ? {} : { signature: event.signature }) });
            } else if (event.type === "tool-call") {
              collectedToolCalls.push({ kind: "valid", id: event.id, name: event.name, input: event.input });
            } else if (event.type === "invalid-tool-call") {
              collectedToolCalls.push({
                kind: "invalid",
                id: event.id,
                name: event.name,
                rawInput: event.rawInput,
                error: event.error,
              });
            } else if (event.type === "usage") {
              usage = {
                inputTokens: event.inputTokens,
                outputTokens: event.outputTokens,
                ...(event.cacheReadTokens === undefined
                  ? {}
                  : { cacheReadTokens: event.cacheReadTokens }),
                ...(event.cacheCreationTokens === undefined
                  ? {}
                  : { cacheCreationTokens: event.cacheCreationTokens }),
              };
            } else if (event.type === "error") {
              terminalError = event.error;
              break;
            } else if (event.type === "done") {
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
          } else if (completed && assistantText.trim().length === 0 && collectedToolCalls.length === 0) {
            completed = false;
            terminalError = {
              code: "empty_response",
              message: "Provider completed without visible text or tool calls",
            };
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
                durationMs: Math.max(0, Date.now() - modelStartedAt),
                ...(usage === undefined ? {} : {
                  inputTokens: usage.inputTokens,
                  outputTokens: usage.outputTokens,
                  ...(usage.cacheReadTokens === undefined ? {} : { cacheReadTokens: usage.cacheReadTokens }),
                  ...(usage.cacheCreationTokens === undefined ? {} : { cacheCreationTokens: usage.cacheCreationTokens }),
                }),
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
          if (journalModelId !== undefined) {
            this.#options.modelJournal?.complete(journalModelId, completed, terminalError?.message);
          }
        }
        yield { type: "model-end", id: modelCallId };

        if (usage !== undefined) {
          this.#options.context.recordModelUsage(usage.inputTokens);
          totalInputTokens += usage.inputTokens;
          totalOutputTokens += usage.outputTokens;
          if (usage.cacheReadTokens !== undefined || usage.cacheCreationTokens !== undefined) {
            hasCacheData = true;
          }
          totalCacheReadTokens += usage.cacheReadTokens ?? 0;
          totalCacheCreationTokens += usage.cacheCreationTokens ?? 0;
          yield { type: "usage", ...usage, totalInputTokens, totalOutputTokens };
        }
        const providerProducedOutput = assistantText.trim().length > 0 || collectedToolCalls.length > 0;
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

      const toolCalls: Array<{ id: string; name: string; input: unknown }> = [];
      for (const collected of collectedToolCalls) {
        const definition = this.#options.runtime.definition(collected.name);
        if (definition === undefined) {
          toolCalls.push({
            id: collected.id,
            name: collected.name,
            input: collected.kind === "valid" ? collected.input : collected.rawInput,
          });
          continue;
        }

        const validation = collected.kind === "valid"
          ? this.#options.runtime.normalize(collected)
          : { ok: false as const, error: collected.error };
        if (validation.ok) {
          toolCalls.push({ id: collected.id, name: collected.name, input: validation.input });
          continue;
        }
        const repairModelId = this.#options.fallbackModelId ?? this.#options.modelId;
        const invalidOutput = collected.kind === "invalid"
          ? collected.rawInput
          : serializeToolInput(collected.input);
        const structured = withStructuredOutput({
          registry: this.#options.registry,
          modelId: repairModelId,
          name: definition.name,
          description: definition.description,
          schema: definition.inputSchema,
          ...(definition.modelInputSchema === undefined ? {} : { modelInputSchema: definition.modelInputSchema }),
          ...(definition.modelStrict === undefined ? {} : { modelStrict: definition.modelStrict }),
          beforeAttempt: async ({ attempt: repairAttempt, maxAttempts: repairMaxAttempts, messageCount }) => {
            const before = await this.#options.hooks.emit({
              version: 1,
              type: "BeforeModelCall",
              payload: {
                modelId: repairModelId,
                iteration,
                messageCount,
                attempt: repairAttempt,
                maxAttempts: repairMaxAttempts,
                purpose: "structured-output-repair",
                tool: collected.name,
                repairAttempt,
                repairMaxAttempts,
              },
            });
            if (before.decision === "deny") {
              throw new Error(before.reason ?? "Structured output repair denied by hook");
            }
          },
          afterAttempt: async ({
            attempt: repairAttempt,
            maxAttempts: repairMaxAttempts,
            completed: repairCompleted,
            error,
          }) => {
            await this.#options.hooks.emit({
              version: 1,
              type: "AfterModelCall",
              payload: {
                modelId: repairModelId,
                iteration,
                attempt: repairAttempt,
                maxAttempts: repairMaxAttempts,
                completed: repairCompleted,
                agent: this.#options.agent,
                providerError: !repairCompleted,
                purpose: "structured-output-repair",
                tool: collected.name,
                repairAttempt,
                repairMaxAttempts,
                ...(error === undefined ? {} : {
                  errorCode: error.code,
                  errorMessage: error.message,
                }),
              },
            });
          },
        });

        let repairedInput: unknown;
        let activeRepairModelCallId: string | undefined;
        try {
          for await (const event of structured.stream({
            messages: [{ role: "user", content: `Repair the invalid arguments for tool "${collected.name}".` }],
            invalidOutput,
            validationError: validation.error.message,
            ...(request.signal === undefined ? {} : { signal: request.signal }),
          })) {
            if (event.type === "attempt-start") {
              activeRepairModelCallId = String(++modelInvocation);
              yield { type: "model-start", id: activeRepairModelCallId };
            } else if (event.type === "attempt-end") {
              if (activeRepairModelCallId !== undefined) {
                yield { type: "model-end", id: activeRepairModelCallId };
                activeRepairModelCallId = undefined;
              }
            } else if (event.type === "usage") {
              this.#options.context.recordModelUsage(event.inputTokens);
              totalInputTokens += event.inputTokens;
              totalOutputTokens += event.outputTokens;
              yield {
                type: "usage",
                inputTokens: event.inputTokens,
                outputTokens: event.outputTokens,
                totalInputTokens,
                totalOutputTokens,
              };
            } else if (event.type === "retry") {
              yield {
                type: "structured-output-retry",
                tool: collected.name,
                modelId: repairModelId,
                attempt: event.attempt,
                maxAttempts: event.maxAttempts,
                delayMs: event.delayMs,
                error: event.error,
              };
            } else {
              repairedInput = event.value;
            }
          }
        } catch (error) {
          if (activeRepairModelCallId !== undefined) {
            yield { type: "model-end", id: activeRepairModelCallId };
          }
          if (request.signal?.aborted) {
            yield { type: "error", error: { code: "cancelled", message: abortMessage(request.signal) } };
          } else {
            const normalized = normalizeProviderError(error);
            yield {
              type: "error",
              error: { code: "structured_output_error", message: normalized.message },
            };
          }
          return;
        }
        if (repairedInput === undefined) {
          yield {
            type: "error",
            error: { code: "structured_output_error", message: `Structured output repair for "${collected.name}" returned no value` },
          };
          return;
        }
        toolCalls.push({ id: collected.id, name: collected.name, input: repairedInput });
      }

      if (toolCalls.length === 0 && assistantText) {
        this.#options.context.append({
          role: "assistant",
          content: assistantText,
        });
      }
      if (toolCalls.length === 0) {
        // Hallucination guard: for main agent, check confidence before declaring done
        if (this.#options.hallucinationGuard !== undefined && this.#options.agent === "main") {
          try {
            const report = await this.#options.hallucinationGuard.evaluate(request.prompt, accumulatedText);
            for (const warning of report.warnings) {
              yield { type: "warning", message: warning };
            }
          } catch {
            // Guard failure is non-fatal for interactive sessions
          }
        }
        if (deliverables.size > 0) yield { type: "deliverables", files: [...deliverables.values()] };
        yield {
          type: "done",
          usage: {
            inputTokens: totalInputTokens,
            outputTokens: totalOutputTokens,
            ...(hasCacheData
              ? {
                  cacheReadTokens: totalCacheReadTokens,
                  cacheCreationTokens: totalCacheCreationTokens,
                }
              : {}),
          },
        };
        return;
      }

      const stagedMessages: ModelMessage[] = [];
      const stagedResults: Array<{ call: (typeof toolCalls)[number]; result: ToolResult }> = [];
      let turnError: ReturnType<typeof normalizeProviderError> | undefined;
      this.#options.runtime.beginTurn();
      for (let index = 0; index < toolCalls.length;) {
        if (request.signal?.aborted) {
          turnError = { code: "cancelled", message: abortMessage(request.signal) };
          stageSyntheticResults(toolCalls, index, turnError, stagedMessages);
          break;
        }
        const batchEnd = parallelReadBatchEnd(toolCalls, index);
        const batch = toolCalls.slice(index, batchEnd);
        for (const call of batch) {
          const label = this.#options.runtime.label(call);
          const hint = this.#options.runtime.hint(call);
          const presentation = this.#options.runtime.callPresentation(call);
          this.#options.hallucinationGuard?.recordToolCall(call.name, call.input, call.id);
          yield { type: "tool-start", id: call.id, name: call.name, input: call.input, ...(label === undefined ? {} : { label }), ...(hint === undefined ? {} : { hint }), ...(presentation === undefined ? {} : { presentation }) };
        }
        const results = await Promise.all(batch.map(async (call) => ({
          call,
          result: await this.#options.runtime.execute(call, {
            agent: this.#options.agent,
            ...(this.#options.ownerId === undefined ? {} : { ownerId: this.#options.ownerId }),
            ...(request.signal === undefined ? {} : { signal: request.signal }),
          }),
        })));
        if (request.signal?.aborted) {
          turnError = { code: "cancelled", message: abortMessage(request.signal) };
          stagedResults.push({ call: batch[0]!, result: { ok: false, error: turnError } });
          stageSyntheticResults(toolCalls, index, turnError, stagedMessages);
          break;
        }
        for (let resultIndex = 0; resultIndex < results.length; resultIndex += 1) {
          const { call, result } = results[resultIndex]!;
          try {
            stagedMessages.push(toolResultMessage(call.id, result));
            stagedResults.push({ call, result });
          } catch (error) {
            turnError = normalizeProviderError(error);
            stageSyntheticResults(toolCalls, index + resultIndex, {
              code: "serialization_error",
              message: turnError.message,
            }, stagedMessages);
            break;
          }
        }
        if (turnError !== undefined) break;
        index = batchEnd;
      }
      const assistantMessage: ModelMessage = {
        role: "assistant",
        content: assistantText,
        toolCalls: toolCalls.map(({ id, name, input }) => ({ id, name, input })),
        ...(collectedThinking.length === 0 ? {} : { thinkingBlocks: collectedThinking.map((block) => ({ ...block })) }),
      };
      this.#options.context.appendMany([assistantMessage, ...stagedMessages]);
      for (const { call, result } of stagedResults) {
        const endLabel = this.#options.runtime.label(call);
        const endHint = this.#options.runtime.hint(call);
        this.#options.hallucinationGuard?.recordToolResult(call.name, result, call.id);
        if (result.ok && result.presentation?.kind === "file-change") {
          for (const change of [result.presentation, ...(result.presentation.relatedChanges ?? [])]) {
            const current = deliverables.get(change.path);
            deliverables.set(change.path, current === undefined
              ? { path: change.path, operation: change.operation, added: change.added, removed: change.removed }
              : { ...current, operation: change.operation, added: current.added + change.added, removed: current.removed + change.removed });
          }
        }
        yield { type: "tool-end", id: call.id, name: call.name, result, ...(endLabel === undefined ? {} : { label: endLabel }), ...(endHint === undefined ? {} : { hint: endHint }) };
        for (const context of result.additionalContext ?? []) this.#options.context.append({ role: "system", content: context });
      }
      if (turnError !== undefined) {
        yield { type: "error", error: turnError };
        return;
      }
      const steering = request.getSteeringMessages?.() ?? [];
      for (const prompt of steering) {
        const content = prompt.trim();
        if (content.length > 0) this.#options.context.append({ role: "user", content });
      }

      iteration += 1;
    }
  }
}

const PARALLEL_READ_TOOLS = new Set([
  "Read",
  "Glob",
  "Grep",
  "LspFindRefs",
  "LspHover",
  "LspDiagnostics",
]);

function parallelReadBatchEnd(
  calls: readonly { name: string }[],
  start: number,
): number {
  if (!PARALLEL_READ_TOOLS.has(calls[start]!.name)) return start + 1;
  let end = start + 1;
  while (end < calls.length && PARALLEL_READ_TOOLS.has(calls[end]!.name)) end += 1;
  return end;
}

function toolResultMessage(toolCallId: string, result: ToolResult): ModelMessage {
  return { role: "tool", toolCallId, content: result.ok && result.content !== undefined
    ? result.content
    : (JSON.stringify(result.ok ? result.output : { error: result.error }) ?? "null") };
}

function abortMessage(signal: AbortSignal): string {
  return signal.reason instanceof Error ? signal.reason.message : "Agent run cancelled";
}

function serializeToolInput(input: unknown): string {
  try { return JSON.stringify(input) ?? String(input); }
  catch { return String(input); }
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
