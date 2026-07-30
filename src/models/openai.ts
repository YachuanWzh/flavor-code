import OpenAI from "openai";
import { readFile } from "node:fs/promises";
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
  modelContentText,
} from "./types.js";
import { normalizeToolCallInput } from "../utils/json.js";

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

async function toInput(message: ModelMessage): Promise<ResponseInputItem[]> {
  if (message.role === "tool") {
    if (!message.toolCallId) throw new Error("Tool messages require toolCallId");
    return [{
      type: "function_call_output",
      call_id: message.toolCallId,
      output: modelContentText(message.content),
    }];
  }
  const content = typeof message.content === "string"
    ? message.content
    : await Promise.all(message.content.map(async (block) => block.type === "text"
      ? { type: "input_text" as const, text: block.text }
      : {
          type: "input_image" as const,
          image_url: `data:${block.mediaType};base64,${(await readFile(block.source.path)).toString("base64")}`,
          detail: "auto" as const,
        }));
  return [
    ...(typeof content === "string"
      ? (content ? [{ role: message.role, content } as ResponseInputItem] : [])
      : (content.length > 0 ? [{ role: message.role, content } as unknown as ResponseInputItem] : [])),
    ...(message.toolCalls ?? []).map((call): ResponseInputItem => ({
      type: "function_call",
      call_id: call.id,
      name: call.name,
      arguments: JSON.stringify(call.input) ?? "null",
    })),
  ];
}

function toolCallEvent(id: string, name: string, rawInput: string): ModelEvent {
  try {
    return { type: "tool-call", id, name, input: normalizeToolCallInput(rawInput) };
  } catch (error) {
    return {
      type: "invalid-tool-call",
      id,
      name,
      rawInput,
      error: {
        code: "invalid_tool_arguments",
        message: error instanceof Error ? error.message : String(error),
      },
    };
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
        input: (await Promise.all(request.messages.map(toInput))).flat(),
        tools: request.tools.map((tool) => ({
          type: "function",
          name: tool.name,
          description: tool.description,
          parameters: tool.inputSchema,
          strict: tool.strict ?? true,
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
            yield toolCallEvent(event.item.call_id, pending.name, pending.arguments);
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
            yield toolCallEvent(callId, event.name, event.arguments ?? "");
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
          if (event.response?.usage !== undefined) {
            yield {
              type: "usage",
              inputTokens: event.response.usage.input_tokens ?? 0,
              outputTokens: event.response.usage.output_tokens ?? 0,
            };
          }
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
