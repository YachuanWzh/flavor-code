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
}

export class AgentLoop {
  readonly #options: Required<Pick<AgentLoopOptions, "maxIterations">> & Omit<AgentLoopOptions, "maxIterations">;

  constructor(options: AgentLoopOptions) {
    const maxIterations = options.maxIterations ?? 20;
    if (maxIterations <= 0 || !Number.isInteger(maxIterations)) throw new Error("maxIterations must be a positive integer");
    this.#options = { ...options, maxIterations };
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
        if (await this.#options.context.compact()) yield { type: "compacted" };
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

      if (assistantText || toolCalls.length > 0) {
        this.#options.context.append({
          role: "assistant",
          content: assistantText,
          ...(toolCalls.length === 0 ? {} : {
            toolCalls: toolCalls.map(({ id, name, input }) => ({ id, name, input })),
          }),
        });
      }
      if (toolCalls.length === 0) {
        yield { type: "done", usage: { inputTokens: totalInputTokens, outputTokens: totalOutputTokens } };
        return;
      }

      for (const call of toolCalls) {
        if (request.signal?.aborted) {
          yield { type: "error", error: { code: "cancelled", message: abortMessage(request.signal) } };
          return;
        }
        yield { type: "tool-start", id: call.id, name: call.name, input: call.input };
        const result = await this.#options.runtime.execute(call, { agent: "main", ...(request.signal === undefined ? {} : { signal: request.signal }) });
        if (request.signal?.aborted) {
          yield { type: "error", error: { code: "cancelled", message: abortMessage(request.signal) } };
          return;
        }
        try {
          const message = toolResultMessage(call.id, result);
          this.#options.context.append(message);
        } catch (error) {
          yield { type: "error", error: normalizeProviderError(error) };
          return;
        }
        yield { type: "tool-end", id: call.id, name: call.name, result };
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
