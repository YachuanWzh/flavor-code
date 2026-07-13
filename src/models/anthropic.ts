import Anthropic from "@anthropic-ai/sdk";
import type {
  MessageDeltaUsage,
  MessageParam,
  MessageStreamParams,
  RawMessageStreamEvent,
  Usage,
} from "@anthropic-ai/sdk/resources/messages/messages.js";

import {
  normalizeProviderError,
  type ModelAdapter,
  type ModelEvent,
  type ModelRequest,
} from "./types.js";
import { normalizeToolCallInput } from "../utils/json.js";

export interface AnthropicClient {
  messages: {
    stream(
      body: MessageStreamParams,
      options?: Anthropic.RequestOptions,
    ): AsyncIterable<RawMessageStreamEvent>;
  };
}

export interface AnthropicModelAdapterOptions {
  apiKey?: string;
  baseURL?: string;
  client?: AnthropicClient;
  maxOutputTokens?: number;
}

const DEFAULT_MAX_OUTPUT_TOKENS = 32_768;

type AnthropicUsage = Pick<
  Usage | MessageDeltaUsage,
  | "input_tokens"
  | "cache_creation_input_tokens"
  | "cache_read_input_tokens"
  | "output_tokens"
>;

interface PendingToolCall {
  id: string;
  name: string;
  json: string;
}

interface InputUsageSnapshot {
  base: number;
  cacheCreation: number;
  cacheRead: number;
}

function updateInputUsage(snapshot: InputUsageSnapshot, usage: AnthropicUsage | undefined): number {
  if (usage?.input_tokens != null) snapshot.base = usage.input_tokens;
  if (usage?.cache_creation_input_tokens != null) {
    snapshot.cacheCreation = usage.cache_creation_input_tokens;
  }
  if (usage?.cache_read_input_tokens != null) {
    snapshot.cacheRead = usage.cache_read_input_tokens;
  }
  return snapshot.base + snapshot.cacheCreation + snapshot.cacheRead;
}

export class AnthropicModelAdapter implements ModelAdapter {
  private readonly client: AnthropicClient;
  private readonly maxOutputTokens: number;

  constructor(options: AnthropicModelAdapterOptions) {
    const maxOutputTokens = options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
    if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens <= 0) {
      throw new Error("maxOutputTokens must be a positive integer");
    }
    this.maxOutputTokens = maxOutputTokens;
    this.client =
      options.client ??
      new Anthropic({
        ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
        ...(options.baseURL === undefined ? {} : { baseURL: options.baseURL }),
      });
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
    let inputTokens = 0;
    let outputTokens = 0;
    let hasUsage = false;
    let usageEmitted = false;
    let stopReason: string | null | undefined;
    const inputUsage = { base: 0, cacheCreation: 0, cacheRead: 0 };
    const pendingTools = new Map<number, PendingToolCall>();
    const completedTools: PendingToolCall[] = [];

    try {
      const system = request.messages
        .filter((message) => message.role === "system")
        .map((message) => message.content)
        .join("\n\n");
      const messages: MessageParam[] = [];
      const nonSystem = request.messages.filter((m) => m.role !== "system");
      for (let i = 0; i < nonSystem.length; i += 1) {
        const message = nonSystem[i]!;
        if (message.role === "tool") {
          if (!message.toolCallId) throw new Error("Tool messages require toolCallId");
          const results: Array<{ type: "tool_result"; tool_use_id: string; content: string }> = [
            { type: "tool_result", tool_use_id: message.toolCallId, content: message.content },
          ];
          while (i + 1 < nonSystem.length && nonSystem[i + 1]!.role === "tool") {
            i += 1;
            const next = nonSystem[i]!;
            if (!next.toolCallId) throw new Error("Tool messages require toolCallId");
            results.push({ type: "tool_result", tool_use_id: next.toolCallId, content: next.content });
          }
          messages.push({ role: "user" as const, content: results });
        } else if (message.role === "assistant" && message.toolCalls?.length) {
          messages.push({
            role: "assistant",
            content: [
              ...(message.content ? [{ type: "text" as const, text: message.content }] : []),
              ...message.toolCalls.map((call) => ({
                type: "tool_use" as const,
                id: call.id,
                name: call.name,
                input: call.input,
              })),
            ],
          });
        } else {
          messages.push({ role: message.role, content: message.content } as MessageParam);
        }
      }

      const body: MessageStreamParams = {
        model: request.model,
        max_tokens: this.maxOutputTokens,
        messages,
        ...(system ? { system } : {}),
        tools: request.tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          input_schema: { ...tool.inputSchema, type: "object" as const },
        })),
      };
      const stream = this.client.messages.stream(body, { signal: request.signal });

      for await (const event of stream) {
        if (event.type === "message_start") {
          hasUsage = event.message?.usage !== undefined;
          inputTokens = updateInputUsage(inputUsage, event.message?.usage);
          outputTokens = event.message?.usage?.output_tokens ?? outputTokens;
        } else if (
          event.type === "content_block_start" &&
          event.content_block?.type === "tool_use" &&
          event.index !== undefined &&
          event.content_block.id &&
          event.content_block.name
        ) {
          pendingTools.set(event.index, {
            id: event.content_block.id,
            name: event.content_block.name,
            json: "",
          });
        } else if (event.type === "content_block_delta" && event.delta?.type === "text_delta") {
          if (event.delta.text) yield { type: "text", text: event.delta.text };
        } else if (
          event.type === "content_block_delta" &&
          event.delta?.type === "input_json_delta" &&
          event.index !== undefined
        ) {
          const pending = pendingTools.get(event.index);
          if (pending) pending.json += event.delta.partial_json ?? "";
        } else if (event.type === "content_block_stop" && event.index !== undefined) {
          const pending = pendingTools.get(event.index);
          if (pending) {
            completedTools.push(pending);
            pendingTools.delete(event.index);
          }
        } else if (event.type === "message_delta") {
          stopReason = event.delta?.stop_reason ?? stopReason;
          hasUsage ||= event.usage !== undefined;
          inputTokens = updateInputUsage(inputUsage, event.usage);
          outputTokens = event.usage?.output_tokens ?? outputTokens;
        } else if (event.type === "message_stop") {
          const usage = { inputTokens, outputTokens };
          if (stopReason === "max_tokens" || stopReason === "model_context_window_exceeded") {
            usageEmitted = true;
            yield { type: "usage", ...usage };
            yield {
              type: "error",
              error: {
                code: "output_limit",
                message: `Provider stopped at the ${this.maxOutputTokens}-token output limit; incomplete tool calls were discarded`,
              },
            };
            return;
          }
          if (pendingTools.size > 0) {
            throw new Error(`Provider stopped with ${pendingTools.size} incomplete tool-call block(s)`);
          }
          for (const pending of completedTools) {
            let input: Record<string, unknown>;
            try {
              input = normalizeToolCallInput(pending.json || "{}");
            } catch (error) {
              const detail = error instanceof Error ? error.message : String(error);
              throw new Error(`Invalid tool-call input for "${pending.name}": ${detail}`);
            }
            yield { type: "tool-call", id: pending.id, name: pending.name, input };
          }
          usageEmitted = true;
          yield { type: "usage", ...usage };
          yield { type: "done", usage };
        }
      }
    } catch (error) {
      if (hasUsage && !usageEmitted) yield { type: "usage", inputTokens, outputTokens };
      yield { type: "error", error: normalizeProviderError(error) };
    }
  }
}
