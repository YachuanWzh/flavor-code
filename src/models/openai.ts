import OpenAI from "openai";
import { createHash } from "node:crypto";
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
import { createScopedAbortSignal } from "../utils/abort.js";
import { openAIJsonSchemaObject } from "./structured.js";

type OpenAIStreamRequest = Parameters<OpenAI["responses"]["stream"]>[0];
export const DEFAULT_THINKING_EFFORT = "high" as const;
export type ThinkingEffort = "minimal" | "low" | "medium" | "high" | "xhigh" | "ultra";

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
  /** Reasoning effort requested from the Responses API; defaults to high. */
  thinkingEffort?: ThinkingEffort;
}

type PromptCacheMode = "full" | "key-only" | "none";

const EXPLICIT_CACHE_BREAKPOINT = { mode: "explicit" as const };
const MAX_EXPLICIT_CACHE_BREAKPOINTS = 3;

async function toInput(message: ModelMessage, cacheBreakpoint = false): Promise<ResponseInputItem[]> {
  if (message.role === "tool") {
    if (!message.toolCallId) throw new Error("Tool messages require toolCallId");
    return [{
      type: "function_call_output",
      call_id: message.toolCallId,
      output: cacheBreakpoint
        ? [{
            type: "input_text",
            text: modelContentText(message.content),
            prompt_cache_breakpoint: EXPLICIT_CACHE_BREAKPOINT,
          }]
        : modelContentText(message.content),
    } as ResponseInputItem];
  }
  const content: string | Array<Record<string, unknown>> = typeof message.content === "string"
    ? (cacheBreakpoint && message.content.length > 0
        ? [{
            type: "input_text" as const,
            text: message.content,
            prompt_cache_breakpoint: EXPLICIT_CACHE_BREAKPOINT,
          }]
        : message.content)
    : await Promise.all(message.content.map(async (block) => block.type === "text"
      ? { type: "input_text" as const, text: block.text }
      : {
          type: "input_image" as const,
          image_url: `data:${block.mediaType};base64,${(await readFile(block.source.path)).toString("base64")}`,
          detail: "auto" as const,
        }));
  if (cacheBreakpoint && Array.isArray(content) && content.length > 0) {
    content[content.length - 1] = {
      ...content[content.length - 1]!,
      prompt_cache_breakpoint: EXPLICIT_CACHE_BREAKPOINT,
    };
  }
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
  total: number;
}

function breakdownFromUsage(usage: unknown): OpenAIUsageBreakdown | undefined {
  if (typeof usage !== "object" || usage === null) return undefined;
  const input = usage as Record<string, unknown>;
  const details = typeof input.input_tokens_details === "object" && input.input_tokens_details !== null
    ? input.input_tokens_details as Record<string, unknown>
    : {};
  const officialCached = typeof details.cached_tokens === "number" ? details.cached_tokens : undefined;
  const officialWrite = typeof details.cache_write_tokens === "number" ? details.cache_write_tokens : undefined;
  const deepSeekHit = typeof input.prompt_cache_hit_tokens === "number" ? input.prompt_cache_hit_tokens : undefined;
  const deepSeekMiss = typeof input.prompt_cache_miss_tokens === "number" ? input.prompt_cache_miss_tokens : undefined;
  const cacheRead = officialCached ?? deepSeekHit ?? 0;
  const cacheCreation = officialWrite ?? 0;
  const reportedTotal = typeof input.input_tokens === "number" ? input.input_tokens : undefined;
  const total = reportedTotal
    ?? (officialCached !== undefined || officialWrite !== undefined
      ? cacheRead + cacheCreation
      : cacheRead + (deepSeekMiss ?? 0));
  const base = deepSeekMiss ?? Math.max(0, total - cacheRead - cacheCreation);
  if (total === 0 && cacheRead === 0 && cacheCreation === 0) return undefined;
  return { base, cacheRead, cacheCreation, total };
}

function formatOpenAIUsage(model: string, breakdown: OpenAIUsageBreakdown): string {
  const total = breakdown.total;
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
  private readonly thinkingEffort: ThinkingEffort;
  /** Capability is remembered per model so compatible gateways pay at most one downgrade retry. */
  readonly #promptCacheModes = new Map<string, PromptCacheMode>();

  constructor(options: OpenAIModelAdapterOptions) {
    this.client =
      options.client ??
      new OpenAI({
        ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
        ...(options.baseURL === undefined ? {} : { baseURL: options.baseURL }),
      });
    this.debugUsage = options.debugUsage ?? isEnvTruthy(process.env.FLAVOR_DEBUG_USAGE);
    this.thinkingEffort = options.thinkingEffort ?? DEFAULT_THINKING_EFFORT;
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

  #promptCacheMode(model: string): PromptCacheMode {
    return this.#promptCacheModes.get(model) ?? "full";
  }

  #downgradePromptCache(model: string, mode: PromptCacheMode): boolean {
    if (mode === "full") {
      this.#promptCacheModes.set(model, "key-only");
      return true;
    }
    if (mode === "key-only") {
      this.#promptCacheModes.set(model, "none");
      return true;
    }
    return false;
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
    const requestAbort = createScopedAbortSignal(request.signal);
    const promptCacheMode = this.#promptCacheMode(request.model);
    let receivedProviderEvent = false;
    const callIds = new Map<number, string>();
    const pendingCalls = new Map<number, { name: string; arguments: string }>();
    const emittedCalls = new Set<number>();
    try {
      const sortedTools = [...request.tools].sort((a, b) => a.name.localeCompare(b.name));
      const explicitBreakpoints = promptCacheMode === "full"
        ? selectExplicitBreakpointIndexes(request.messages)
        : new Set<number>();
      const body = {
        model: request.model,
        input: (await Promise.all(request.messages.map((message, index) => (
          toInput(message, explicitBreakpoints.has(index))
        )))).flat(),
        reasoning: { effort: this.thinkingEffort },
        tools: sortedTools.map((tool) => ({
          type: "function",
          name: tool.name,
          description: tool.description,
          parameters: openAIJsonSchemaObject(tool.inputSchema, tool.strict ?? true),
          strict: tool.strict ?? true,
        })),
        ...(promptCacheMode === "none"
          ? {}
          : { prompt_cache_key: promptCacheKey(request, sortedTools) }),
        ...(promptCacheMode === "full"
          ? { prompt_cache_options: { mode: "implicit" as const, ttl: "30m" as const } }
          : {}),
      } as unknown as OpenAIStreamRequest;
      const stream = this.client.responses.stream(body, { signal: requestAbort.signal });

      for await (const event of stream) {
        if (
          !receivedProviderEvent
          && event.type === "error"
          && isPromptCacheParamRejected(event)
        ) {
          throw event;
        }
        if (
          !receivedProviderEvent
          && event.type === "response.failed"
          && isPromptCacheParamRejected(event.response?.error)
        ) {
          throw event.response?.error ?? event;
        }
        receivedProviderEvent = true;
        if (
          event.type === "response.output_item.added" &&
          event.item?.type === "function_call" &&
          event.output_index !== undefined &&
          event.item.call_id
        ) {
          callIds.set(event.output_index, event.item.call_id);
          const pending = pendingCalls.get(event.output_index);
          if (pending && !emittedCalls.has(event.output_index)) {
            yield toolCallEvent(event.item.call_id, pending.name, pending.arguments);
            emittedCalls.add(event.output_index);
            pendingCalls.delete(event.output_index);
          }
        } else if (
          event.type === "response.output_item.done" &&
          event.item?.type === "function_call" &&
          event.output_index !== undefined &&
          event.item.call_id
        ) {
          callIds.set(event.output_index, event.item.call_id);
          if (!emittedCalls.has(event.output_index)) {
            const pending = pendingCalls.get(event.output_index);
            yield toolCallEvent(
              event.item.call_id,
              pending?.name ?? event.item.name,
              pending?.arguments ?? event.item.arguments,
            );
            emittedCalls.add(event.output_index);
            pendingCalls.delete(event.output_index);
          }
        } else if (event.type === "response.output_text.delta" && event.delta) {
          yield { type: "text", text: event.delta };
        } else if (
          (event.type === "response.reasoning_summary_text.delta" || event.type === "response.reasoning_text.delta") &&
          event.delta
        ) {
          // Reasoning channels are display-only: providers that expose them
          // either encrypt the blocks or omit them from replay, so there is
          // nothing to echo back and no thinking-block event is emitted.
          yield { type: "thinking", text: event.delta };
        } else if (
          event.type === "response.function_call_arguments.done" &&
          event.output_index !== undefined &&
          event.name
        ) {
          const callId = callIds.get(event.output_index);
          if (callId && !emittedCalls.has(event.output_index)) {
            yield toolCallEvent(callId, event.name, event.arguments ?? "");
            emittedCalls.add(event.output_index);
          } else if (!emittedCalls.has(event.output_index)) {
            pendingCalls.set(event.output_index, {
              name: event.name,
              arguments: event.arguments ?? "",
            });
          }
        } else if (event.type === "response.completed") {
          const breakdown = breakdownFromUsage(event.response?.usage);
          const usage = {
            inputTokens: event.response?.usage?.input_tokens ?? 0,
            outputTokens: event.response?.usage?.output_tokens ?? 0,
            ...(breakdown === undefined
              ? {}
              : {
                  cacheReadTokens: breakdown.cacheRead,
                  cacheCreationTokens: breakdown.cacheCreation,
                }),
          };
          this.#logUsage(request.model, breakdown);
          yield { type: "usage", ...usage };
          yield { type: "done", usage };
        } else if (event.type === "response.incomplete") {
          const breakdown = breakdownFromUsage(event.response?.usage);
          const usage = {
            inputTokens: event.response?.usage?.input_tokens ?? 0,
            outputTokens: event.response?.usage?.output_tokens ?? 0,
            ...(breakdown === undefined
              ? {}
              : {
                  cacheReadTokens: breakdown.cacheRead,
                  cacheCreationTokens: breakdown.cacheCreation,
                }),
          };
          const reason = event.response?.incomplete_details?.reason ?? "unknown reason";
          this.#logUsage(request.model, breakdown);
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
            const breakdown = breakdownFromUsage(event.response.usage);
            this.#logUsage(request.model, breakdown);
            yield {
              type: "usage",
              inputTokens: event.response.usage.input_tokens ?? 0,
              outputTokens: event.response.usage.output_tokens ?? 0,
              ...(breakdown === undefined
                ? {}
                : {
                    cacheReadTokens: breakdown.cacheRead,
                    cacheCreationTokens: breakdown.cacheCreation,
                  }),
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
      if (
        !receivedProviderEvent
        && isPromptCacheParamRejected(error)
        && this.#downgradePromptCache(request.model, promptCacheMode)
      ) {
        yield* this.stream(request);
        return;
      }
      yield { type: "error", error: normalizeProviderError(error) };
    } finally {
      requestAbort.dispose();
    }
  }
}

function selectExplicitBreakpointIndexes(messages: readonly ModelMessage[]): Set<number> {
  const indexes = messages
    .map((message, index) => message.cacheBreakpoint ? index : -1)
    .filter((index) => index >= 0);
  const tail = messages.length - 1;
  if (tail >= 0 && indexes.at(-1) !== tail) indexes.push(tail);
  const firstNonSystem = messages.findIndex((message) => message.role !== "system");
  const leadingSystemEnd = firstNonSystem < 0 ? tail : firstNonSystem - 1;
  const stable = indexes.filter((index) => index <= leadingSystemEnd).at(-1);
  if (stable === undefined) return new Set(indexes.slice(-MAX_EXPLICIT_CACHE_BREAKPOINTS));
  return new Set([
    stable,
    ...indexes.filter((index) => index !== stable).slice(-(MAX_EXPLICIT_CACHE_BREAKPOINTS - 1)),
  ]);
}

function promptCacheKey(request: ModelRequest, sortedTools: readonly ModelRequest["tools"][number][]): string {
  const firstNonSystem = request.messages.findIndex((message) => message.role !== "system");
  const leadingSystemEnd = firstNonSystem < 0 ? request.messages.length - 1 : firstNonSystem - 1;
  // Dynamic context follows the last stable system breakpoint. Keep its edits
  // out of the routing key so the reusable prefix stays on the same shard.
  let stableEnd = -1;
  for (let index = 0; index <= leadingSystemEnd; index += 1) {
    if (request.messages[index]?.cacheBreakpoint) stableEnd = index;
  }
  if (stableEnd < 0) {
    request.messages.forEach((message, index) => {
      if (message.cacheBreakpoint) stableEnd = index;
    });
    stableEnd = Math.max(stableEnd, leadingSystemEnd);
  }
  const stableMessages = stableEnd < 0 ? [] : request.messages.slice(0, stableEnd + 1);
  const digest = createHash("sha256")
    .update(JSON.stringify({ model: request.model, messages: stableMessages, tools: sortedTools }))
    .digest("hex")
    .slice(0, 56);
  return `flavor-${digest}`;
}

function isPromptCacheParamRejected(error: unknown): boolean {
  const status = (error as { status?: unknown } | undefined)?.status;
  if (status !== undefined && status !== 400 && status !== 422) return false;
  const message = error instanceof Error
    ? error.message
    : (typeof (error as { message?: unknown } | undefined)?.message === "string"
        ? (error as { message: string }).message
        : String(error ?? ""));
  return /prompt[_ -]?cache|cache[_ -]?breakpoint/iu.test(message)
    && /(not supported|unsupported|unknown|invalid|extra inputs|unrecognized|not permitted)/iu.test(message);
}
