import OpenAI from "openai";

import {
  normalizeProviderError,
  type ModelAdapter,
  type ModelEvent,
  type ModelMessage,
  type ModelRequest,
} from "./types.js";

interface OpenAIClient {
  responses: {
    stream(body: unknown, options?: unknown): AsyncIterable<unknown>;
  };
}

export interface OpenAIModelAdapterOptions {
  apiKey?: string;
  baseURL?: string;
  client?: OpenAIClient;
}

interface StreamEvent {
  type?: string;
  delta?: string;
  item_id?: string;
  name?: string;
  arguments?: string;
  item?: {
    type?: string;
    id?: string;
    call_id?: string;
  };
  code?: string | null;
  message?: string;
  response?: {
    usage?: { input_tokens?: number; output_tokens?: number } | null;
    error?: { code?: string; message?: string } | null;
  };
}

function toInput(message: ModelMessage): Record<string, unknown> {
  if (message.role === "tool") {
    if (!message.toolCallId) throw new Error("Tool messages require toolCallId");
    return {
      type: "function_call_output",
      call_id: message.toolCallId,
      output: message.content,
    };
  }
  return { role: message.role, content: message.content };
}

function parseJson(input: string): unknown {
  try {
    return JSON.parse(input) as unknown;
  } catch {
    return input;
  }
}

export class OpenAIModelAdapter implements ModelAdapter {
  private readonly client: OpenAIClient;

  constructor(options: OpenAIModelAdapterOptions) {
    this.client =
      options.client ??
      new OpenAI({
        ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
        ...(options.baseURL === undefined ? {} : { baseURL: options.baseURL }),
      });
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
    const callIds = new Map<string, string>();
    try {
      const stream = this.client.responses.stream(
        {
          model: request.model,
          input: request.messages.map(toInput),
          tools: request.tools.map((tool) => ({
            type: "function",
            name: tool.name,
            description: tool.description,
            parameters: tool.inputSchema,
            strict: false,
          })),
        },
        { signal: request.signal },
      );

      for await (const rawEvent of stream) {
        const event = rawEvent as StreamEvent;
        if (
          event.type === "response.output_item.added" &&
          event.item?.type === "function_call" &&
          event.item.id &&
          event.item.call_id
        ) {
          callIds.set(event.item.id, event.item.call_id);
        } else if (event.type === "response.output_text.delta" && event.delta) {
          yield { type: "text", text: event.delta };
        } else if (
          event.type === "response.function_call_arguments.done" &&
          event.item_id &&
          event.name
        ) {
          yield {
            type: "tool-call",
            id: callIds.get(event.item_id) ?? event.item_id,
            name: event.name,
            input: parseJson(event.arguments ?? ""),
          };
        } else if (event.type === "response.completed") {
          const usage = {
            inputTokens: event.response?.usage?.input_tokens ?? 0,
            outputTokens: event.response?.usage?.output_tokens ?? 0,
          };
          yield { type: "usage", ...usage };
          yield { type: "done", usage };
        } else if (event.type === "error") {
          yield { type: "error", error: normalizeProviderError(event) };
          return;
        } else if (event.type === "response.failed") {
          yield {
            type: "error",
            error: normalizeProviderError(event.response?.error ?? event),
          };
          return;
        }
      }
    } catch (error) {
      yield { type: "error", error: normalizeProviderError(error) };
    }
  }
}
