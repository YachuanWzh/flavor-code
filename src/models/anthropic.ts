import Anthropic from "@anthropic-ai/sdk";

import {
  normalizeProviderError,
  type ModelAdapter,
  type ModelEvent,
  type ModelRequest,
} from "./types.js";

interface AnthropicClient {
  messages: {
    stream(body: unknown, options?: unknown): AsyncIterable<unknown>;
  };
}

export interface AnthropicModelAdapterOptions {
  apiKey?: string;
  baseURL?: string;
  client?: AnthropicClient;
}

interface AnthropicEvent {
  type?: string;
  index?: number;
  message?: { usage?: { input_tokens?: number; output_tokens?: number } };
  usage?: { input_tokens?: number | null; output_tokens?: number };
  content_block?: { type?: string; id?: string; name?: string };
  delta?: { type?: string; text?: string; partial_json?: string };
}

interface PendingToolCall {
  id: string;
  name: string;
  json: string;
}

function parseJson(input: string): unknown {
  try {
    return JSON.parse(input) as unknown;
  } catch {
    return input;
  }
}

export class AnthropicModelAdapter implements ModelAdapter {
  private readonly client: AnthropicClient;

  constructor(options: AnthropicModelAdapterOptions) {
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
    const pendingTools = new Map<number, PendingToolCall>();

    try {
      const system = request.messages
        .filter((message) => message.role === "system")
        .map((message) => message.content)
        .join("\n\n");
      const messages = request.messages
        .filter((message) => message.role !== "system")
        .map((message) => {
          if (message.role === "tool") {
            if (!message.toolCallId) throw new Error("Tool messages require toolCallId");
            return {
              role: "user",
              content: [
                {
                  type: "tool_result",
                  tool_use_id: message.toolCallId,
                  content: message.content,
                },
              ],
            };
          }
          return { role: message.role, content: message.content };
        });

      const stream = this.client.messages.stream(
        {
          model: request.model,
          max_tokens: 4096,
          messages,
          ...(system ? { system } : {}),
          tools: request.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            input_schema: tool.inputSchema,
          })),
        },
        { signal: request.signal },
      );

      for await (const rawEvent of stream) {
        const event = rawEvent as AnthropicEvent;
        if (event.type === "message_start") {
          inputTokens = event.message?.usage?.input_tokens ?? inputTokens;
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
            yield {
              type: "tool-call",
              id: pending.id,
              name: pending.name,
              input: parseJson(pending.json || "{}"),
            };
            pendingTools.delete(event.index);
          }
        } else if (event.type === "message_delta") {
          inputTokens = event.usage?.input_tokens ?? inputTokens;
          outputTokens = event.usage?.output_tokens ?? outputTokens;
        } else if (event.type === "message_stop") {
          const usage = { inputTokens, outputTokens };
          yield { type: "usage", ...usage };
          yield { type: "done", usage };
        }
      }
    } catch (error) {
      yield { type: "error", error: normalizeProviderError(error) };
    }
  }
}
