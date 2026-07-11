import type { ContextManager } from "../context/manager.js";
import type { HookBus } from "../hooks/bus.js";
import type { ModelRegistry } from "../models/registry.js";
import { normalizeProviderError, type ModelMessage, type ModelTool } from "../models/types.js";
import type { ToolRuntime } from "../tools/runtime.js";
import type { ToolResult } from "../tools/types.js";
import type { AgentEvent, AgentRunRequest } from "./types.js";

export interface AgentLoopOptions {
  registry: ModelRegistry;
  modelId: string;
  context: ContextManager;
  runtime: ToolRuntime;
  hooks: HookBus;
  tools: readonly ModelTool[];
  maxIterations?: number;
  agent?: "main" | "subagent";
}

export class AgentLoop {
  readonly #options: Required<Pick<AgentLoopOptions, "maxIterations" | "agent">> & Omit<AgentLoopOptions, "maxIterations" | "agent">;

  constructor(options: AgentLoopOptions) {
    const maxIterations = options.maxIterations ?? 20;
    if (maxIterations <= 0 || !Number.isInteger(maxIterations)) throw new Error("maxIterations must be a positive integer");
    this.#options = { ...options, maxIterations, agent: options.agent ?? "main" };
  }

  async *run(request: AgentRunRequest): AsyncIterable<AgentEvent> {
    this.#options.context.append({ role: "user", content: request.prompt });
    let totalInputTokens = 0;
    let totalOutputTokens = 0;

    for (let iteration = 0; iteration < this.#options.maxIterations; iteration += 1) {
      if (request.signal?.aborted) {
        yield { type: "error", error: { code: "cancelled", message: abortMessage(request.signal) } };
        return;
      }
      try {
        if (await this.#options.context.compact(request.signal)) yield { type: "compacted" };
      } catch (error) {
        yield { type: "error", error: normalizeProviderError(error) };
        return;
      }

      let resolved: ReturnType<ModelRegistry["get"]>;
      try { resolved = this.#options.registry.get(this.#options.modelId); }
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
          payload: { modelId: this.#options.modelId, iteration, messageCount: modelRequest.messages.length },
        });
      } catch (error) {
        yield { type: "error", error: normalizeProviderError(error) };
        return;
      }
      if (before.decision === "deny") {
        yield { type: "error", error: { code: "cancelled", message: before.reason ?? "Model call denied by hook" } };
        return;
      }

      let assistantText = "";
      const toolCalls: Array<{ id: string; name: string; input: unknown }> = [];
      let completed = false;
      let terminalError: ReturnType<typeof normalizeProviderError> | undefined;
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
        try {
          await this.#options.hooks.emit({
            version: 1,
            type: "AfterModelCall",
            payload: { modelId: this.#options.modelId, iteration, completed, providerError: terminalError !== undefined },
          });
        } catch (error) {
          terminalError ??= normalizeProviderError(error);
        }
      }

      if (usage !== undefined) {
        totalInputTokens += usage.inputTokens;
        totalOutputTokens += usage.outputTokens;
        yield { type: "usage", ...usage, totalInputTokens, totalOutputTokens };
      }
      if (terminalError !== undefined) {
        yield { type: "error", error: terminalError };
        return;
      }
      if (!completed) {
        yield { type: "error", error: { code: "incomplete_stream", message: "Provider stream ended without a done or error event" } };
        return;
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
        yield { type: "tool-start", id: call.id, name: call.name, input: call.input };
        const result = await this.#options.runtime.execute(call, { agent: this.#options.agent, ...(request.signal === undefined ? {} : { signal: request.signal }) });
        if (request.signal?.aborted) {
          turnError = { code: "cancelled", message: abortMessage(request.signal) };
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
        yield { type: "tool-end", id: call.id, name: call.name, result };
      }
      if (turnError !== undefined) {
        yield { type: "error", error: turnError };
        return;
      }
    }

    yield {
      type: "error",
      error: { code: "iteration_limit", message: `Agent exceeded the ${this.#options.maxIterations} iteration limit` },
    };
  }
}

function toolResultMessage(toolCallId: string, result: ToolResult): ModelMessage {
  return { role: "tool", toolCallId, content: JSON.stringify(result.ok ? result.output : { error: result.error }) ?? "null" };
}

function abortMessage(signal: AbortSignal): string {
  return signal.reason instanceof Error ? signal.reason.message : "Agent run cancelled";
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
