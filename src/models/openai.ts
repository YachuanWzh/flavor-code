import OpenAI from "openai";
import type {
  ResponseInputItem,
  ResponseStreamEvent,
} from "openai/resources/responses/responses.js";

import {
  normalizeProviderError,
  type ModelAdapter,
  type ModelEvent,
  type ModelMessage,
  type ModelRequest,
} from "./types.js";

type OpenAIStreamRequest = Parameters<OpenAI["responses"]["stream"]>[0];

export interface OpenAIClient {
  responses: {
    stream(
      body: OpenAIStreamRequest,
      options?: OpenAI.RequestOptions,
    ): AsyncIterable<ResponseStreamEvent>;
  };
}

export interface OpenAIModelAdapterOptions {
  apiKey?: string;
  baseURL?: string;
  client?: OpenAIClient;
}

function toInput(message: ModelMessage): ResponseInputItem[] {
  if (message.role === "tool") {
    if (!message.toolCallId) throw new Error("Tool messages require toolCallId");
    return [{
      type: "function_call_output",
      call_id: message.toolCallId,
      output: message.content,
    }];
  }
  return [
    ...(message.content ? [{ role: message.role, content: message.content } as ResponseInputItem] : []),
    ...(message.toolCalls ?? []).map((call): ResponseInputItem => ({
      type: "function_call",
      call_id: call.id,
      name: call.name,
      arguments: JSON.stringify(call.input) ?? "null",
    })),
  ];
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
    const callIds = new Map<number, string>();
    const pendingCalls = new Map<number, { name: string; arguments: string }>();
    try {
      const body: OpenAIStreamRequest = {
        model: request.model,
        input: request.messages.flatMap(toInput),
        tools: request.tools.map((tool) => ({
          type: "function",
          name: tool.name,
          description: tool.description,
          parameters: tool.inputSchema,
          strict: false,
        })),
      };
      const stream = this.client.responses.stream(body, { signal: request.signal });

      for await (const event of stream) {
        if (
          (event.type === "response.output_item.added" ||
            event.type === "response.output_item.done") &&
          event.item?.type === "function_call" &&
          event.output_index !== undefined &&
          event.item.call_id
        ) {
          callIds.set(event.output_index, event.item.call_id);
          const pending = pendingCalls.get(event.output_index);
          if (pending) {
            yield {
              type: "tool-call",
              id: event.item.call_id,
              name: pending.name,
              input: parseJson(pending.arguments),
            };
            pendingCalls.delete(event.output_index);
          }
        } else if (event.type === "response.output_text.delta" && event.delta) {
          yield { type: "text", text: event.delta };
        } else if (
          event.type === "response.function_call_arguments.done" &&
          event.output_index !== undefined &&
          event.name
        ) {
          const callId = callIds.get(event.output_index);
          if (callId) {
            yield {
              type: "tool-call",
              id: callId,
              name: event.name,
              input: parseJson(event.arguments ?? ""),
            };
          } else {
            pendingCalls.set(event.output_index, {
              name: event.name,
              arguments: event.arguments ?? "",
            });
          }
        } else if (event.type === "response.completed") {
          const usage = {
            inputTokens: event.response?.usage?.input_tokens ?? 0,
            outputTokens: event.response?.usage?.output_tokens ?? 0,
          };
          yield { type: "usage", ...usage };
          yield { type: "done", usage };
        } else if (event.type === "response.incomplete") {
          const usage = {
            inputTokens: event.response?.usage?.input_tokens ?? 0,
            outputTokens: event.response?.usage?.output_tokens ?? 0,
          };
          const reason = event.response?.incomplete_details?.reason ?? "unknown reason";
          yield { type: "usage", ...usage };
          yield {
            type: "error",
            error: normalizeProviderError({ message: `Response incomplete: ${reason}` }),
          };
          return;
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
