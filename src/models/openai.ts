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
import { isEnvTruthy } from "../utils/envUtils.js";
import { appendUsageLog, currentUsageSession } from "../utils/log.js";

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
  /** Mirror the per-request cache breakdown to stderr. Defaults to FLAVOR_DEBUG_USAGE=1. File logging to usage.jsonl is always on. */
  debugUsage?: boolean;
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

interface OpenAIUsageBreakdown {
  base: number;
  cacheRead: number;
  cacheCreation: number;
}

function breakdownFromUsage(usage: unknown): OpenAIUsageBreakdown | undefined {
  if (typeof usage !== "object" || usage === null) return undefined;
  const input = usage as Record<string, unknown>;
  const details = typeof input.input_tokens_details === "object" && input.input_tokens_details !== null
    ? input.input_tokens_details as Record<string, unknown>
    : {};
  const cached = typeof details.cached_tokens === "number"
    ? details.cached_tokens
    : (typeof input.prompt_cache_hit_tokens === "number" ? input.prompt_cache_hit_tokens : 0);
  const cacheCreation = typeof input.prompt_cache_miss_tokens === "number"
    ? input.prompt_cache_miss_tokens
    : 0;
  const base = typeof input.input_tokens === "number" ? input.input_tokens : 0;
  if (base === 0 && cached === 0 && cacheCreation === 0) return undefined;
  return { base, cacheRead: cached, cacheCreation };
}

function formatOpenAIUsage(model: string, breakdown: OpenAIUsageBreakdown): string {
  const total = breakdown.base + breakdown.cacheCreation + breakdown.cacheRead;
  const hitRatio = total > 0 ? breakdown.cacheRead / total : 0;
  return JSON.stringify({
    event: "flavor-usage",
    sessionId: currentUsageSession(),
    provider: "openai",
    model,
    inputTokens: breakdown.base,
    cacheReadTokens: breakdown.cacheRead,
    cacheCreationTokens: breakdown.cacheCreation,
    totalInputTokens: total,
    cacheHitRatio: Number(hitRatio.toFixed(4)),
  });
}

export class OpenAIModelAdapter implements ModelAdapter {
  private readonly client: OpenAIClient;
  private readonly debugUsage: boolean;

  constructor(options: OpenAIModelAdapterOptions) {
    this.client =
      options.client ??
      new OpenAI({
        ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
        ...(options.baseURL === undefined ? {} : { baseURL: options.baseURL }),
      });
    this.debugUsage = options.debugUsage ?? isEnvTruthy(process.env.FLAVOR_DEBUG_USAGE);
  }

  #logUsage(model: string, breakdown: OpenAIUsageBreakdown | undefined): void {
    if (breakdown === undefined) return;
    const line = formatOpenAIUsage(model, breakdown);
    if (this.debugUsage) {
      try {
        process.stderr.write(`${line}\n`);
      } catch {
        // Debug logging must never break model streaming.
      }
    }
    // File logging is always on; a new session truncates the previous log.
    void appendUsageLog(line);
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
    const callIds = new Map<number, string>();
    const pendingCalls = new Map<number, { name: string; arguments: string }>();
    try {
      const body: OpenAIStreamRequest = {
        model: request.model,
        input: (await Promise.all(request.messages.map(toInput))).flat(),
        tools: [...request.tools].sort((a, b) => a.name.localeCompare(b.name)).map((tool) => ({
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
          this.#logUsage(request.model, breakdownFromUsage(event.response?.usage));
          yield { type: "usage", ...usage };
          yield { type: "done", usage };
        } else if (event.type === "response.incomplete") {
          const usage = {
            inputTokens: event.response?.usage?.input_tokens ?? 0,
            outputTokens: event.response?.usage?.output_tokens ?? 0,
          };
          const reason = event.response?.incomplete_details?.reason ?? "unknown reason";
          this.#logUsage(request.model, breakdownFromUsage(event.response?.usage));
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
            this.#logUsage(request.model, breakdownFromUsage(event.response.usage));
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
