import Anthropic from "@anthropic-ai/sdk";
import { readFile } from "node:fs/promises";
import type {
  MessageDeltaUsage,
  MessageCreateParamsStreaming,
  MessageParam,
  RawMessageStreamEvent,
  Usage,
} from "@anthropic-ai/sdk/resources/messages/messages.js";

import {
  normalizeProviderError,
  type ModelAdapter,
  type ModelEvent,
  type ModelRequest,
  modelContentText,
} from "./types.js";
import { normalizeToolCallInput } from "../utils/json.js";
import { isEnvTruthy } from "../utils/envUtils.js";
import { appendUsageLog, currentUsageSession } from "../utils/log.js";

export interface AnthropicClient {
  messages: {
    create(
      body: MessageCreateParamsStreaming,
      options?: Anthropic.RequestOptions,
    ):
      | AsyncIterable<RawMessageStreamEvent>
      | PromiseLike<AsyncIterable<RawMessageStreamEvent>>;
  };
}

export interface AnthropicModelAdapterOptions {
  apiKey?: string;
  baseURL?: string;
  client?: AnthropicClient;
  maxOutputTokens?: number;
  /** Mirror the per-request cache breakdown to stderr. Defaults to FLAVOR_DEBUG_USAGE=1. File logging to usage.jsonl is always on. */
  debugUsage?: boolean;
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

type AnthropicAssistantBlock =
  | { type: "text"; text: string; cache_control?: { type: "ephemeral" } }
  | { type: "tool_use"; id: string; name: string; input: unknown; cache_control?: { type: "ephemeral" } };

interface InputUsageSnapshot {
  base: number;
  cacheCreation: number;
  cacheRead: number;
}

/** Shape of the outgoing request, kept for FLAVOR_DEBUG_USAGE diagnosis. */
interface RequestShape {
  messages: number;
  markers: number;
}

/** Provider-side cap on cache markers per request (Anthropic and DashScope both enforce 4). */
const MAX_CACHE_MARKERS = 4;

interface CacheMarkerRef {
  blocks: unknown[];
  index: number;
}

function collectCacheMarkers(system: MessageCreateParamsStreaming["system"], messages: MessageParam[]): CacheMarkerRef[] {
  const markers: CacheMarkerRef[] = [];
  const visit = (blocks: unknown[], index: number): void => {
    const block = blocks[index];
    if (
      typeof block === "object" &&
      block !== null &&
      "cache_control" in block &&
      (block as { cache_control?: unknown }).cache_control !== undefined
    ) {
      markers.push({ blocks, index });
    }
  };
  if (Array.isArray(system)) system.forEach((_block, index) => visit(system as unknown[], index));
  for (const message of messages) {
    if (Array.isArray(message.content)) {
      const blocks = message.content as unknown[];
      blocks.forEach((_block, index) => visit(blocks, index));
    }
  }
  return markers;
}

function stripCacheControl(marker: CacheMarkerRef): void {
  const block = marker.blocks[marker.index] as Record<string, unknown>;
  delete block.cache_control;
}

/** Attach a cache marker to the last content block of a message (in place). */
function markLastBlock(message: MessageParam): void {
  const blocks: unknown[] = typeof message.content === "string"
    ? [{ type: "text", text: message.content }]
    : [...message.content];
  if (blocks.length === 0) return;
  const index = blocks.length - 1;
  blocks[index] = {
    ...(blocks[index] as Record<string, unknown>),
    cache_control: { type: "ephemeral" },
  };
  message.content = blocks as unknown as MessageParam["content"];
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

function formatCacheUsage(model: string, snapshot: InputUsageSnapshot, shape?: RequestShape): string {
  const total = snapshot.base + snapshot.cacheCreation + snapshot.cacheRead;
  const hitRatio = total > 0 ? snapshot.cacheRead / total : 0;
  return JSON.stringify({
    event: "flavor-usage",
    sessionId: currentUsageSession(),
    provider: "anthropic",
    model,
    inputTokens: snapshot.base,
    cacheReadTokens: snapshot.cacheRead,
    cacheCreationTokens: snapshot.cacheCreation,
    totalInputTokens: total,
    cacheHitRatio: Number(hitRatio.toFixed(4)),
    ...(shape === undefined ? {} : { requestMessages: shape.messages, requestMarkers: shape.markers }),
  });
}

export class AnthropicModelAdapter implements ModelAdapter {
  private readonly client: AnthropicClient;
  private readonly maxOutputTokens: number;
  private readonly debugUsage: boolean;

  constructor(options: AnthropicModelAdapterOptions) {
    const maxOutputTokens = options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
    if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens <= 0) {
      throw new Error("maxOutputTokens must be a positive integer");
    }
    this.maxOutputTokens = maxOutputTokens;
    this.debugUsage = options.debugUsage ?? isEnvTruthy(process.env.FLAVOR_DEBUG_USAGE);
    this.client =
      options.client ??
      new Anthropic({
        ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
        ...(options.baseURL === undefined ? {} : { baseURL: options.baseURL }),
      });
  }

  #logUsage(request: ModelRequest, snapshot: InputUsageSnapshot, shape?: RequestShape): void {
    const line = formatCacheUsage(request.model, snapshot, shape);
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
    let inputTokens = 0;
    let outputTokens = 0;
    let hasUsage = false;
    let usageEmitted = false;
    let stopReason: string | null | undefined;
    const inputUsage = { base: 0, cacheCreation: 0, cacheRead: 0 };
    let requestShape: RequestShape | undefined;
    const pendingTools = new Map<number, PendingToolCall>();
    const completedTools: PendingToolCall[] = [];

    try {
      const systemMessages = request.messages.filter((message) => message.role === "system");
      const system = systemMessages.some((message) => message.cacheBreakpoint)
        ? systemMessages.map((message) => ({
          type: "text" as const,
          text: modelContentText(message.content),
          ...(message.cacheBreakpoint ? { cache_control: { type: "ephemeral" as const } } : {}),
        }))
        : systemMessages.map((message) => modelContentText(message.content)).join("\n\n");
      const messages: MessageParam[] = [];
      const nonSystem = request.messages.filter((m) => m.role !== "system");
      for (let i = 0; i < nonSystem.length; i += 1) {
        const message = nonSystem[i]!;
        if (message.role === "tool") {
          if (!message.toolCallId) throw new Error("Tool messages require toolCallId");
          const results: Array<{
            type: "tool_result";
            tool_use_id: string;
            content: string;
            cache_control?: { type: "ephemeral" };
          }> = [
            {
              type: "tool_result",
              tool_use_id: message.toolCallId,
              content: modelContentText(message.content),
              ...(message.cacheBreakpoint ? { cache_control: { type: "ephemeral" as const } } : {}),
            },
          ];
          while (i + 1 < nonSystem.length && nonSystem[i + 1]!.role === "tool") {
            i += 1;
            const next = nonSystem[i]!;
            if (!next.toolCallId) throw new Error("Tool messages require toolCallId");
            results.push({
              type: "tool_result",
              tool_use_id: next.toolCallId,
              content: modelContentText(next.content),
              ...(next.cacheBreakpoint ? { cache_control: { type: "ephemeral" as const } } : {}),
            });
          }
          messages.push({ role: "user" as const, content: results });
        } else if (message.role === "assistant" && message.toolCalls?.length) {
          const content: AnthropicAssistantBlock[] = [
            ...(modelContentText(message.content)
              ? [{ type: "text" as const, text: modelContentText(message.content) }]
              : []),
            ...message.toolCalls.map((call) => ({
              type: "tool_use" as const,
              id: call.id,
              name: call.name,
              input: call.input,
            })),
          ];
          if (message.cacheBreakpoint && content.length > 0) {
            content[content.length - 1] = {
              ...content[content.length - 1]!,
              cache_control: { type: "ephemeral" as const },
            };
          }
          messages.push({
            role: "assistant",
            content,
          } as MessageParam);
        } else {
          const content: string | Array<Record<string, unknown>> = typeof message.content === "string"
            ? message.content
            : await Promise.all(message.content.map(async (block): Promise<Record<string, unknown>> => block.type === "text"
              ? { type: "text" as const, text: block.text }
              : {
                  type: "image" as const,
                  source: {
                    type: "base64" as const,
                    media_type: block.mediaType,
                    data: (await readFile(block.source.path)).toString("base64"),
                  },
                }));
          if (message.cacheBreakpoint && Array.isArray(content) && content.length > 0) {
            const last = content[content.length - 1]!;
            if (last.type === "text") {
              content[content.length - 1] = {
                ...last,
                cache_control: { type: "ephemeral" as const },
              };
            }
          }
          messages.push({
            role: message.role,
            content: message.cacheBreakpoint && typeof content === "string"
              ? [{ type: "text", text: content, cache_control: { type: "ephemeral" } }]
              : content,
          } as unknown as MessageParam);
        }
      }

      // Rolling tail breakpoint: cache the conversation up to the final
      // message so the next turn reuses it as a prefix hit. The marker must
      // sit on the last message — DashScope's Anthropic-compatible endpoint
      // honors markers on text/tool_result blocks at the request tail but
      // silently ignores markers placed on assistant tool_use blocks.
      // Providers cap markers per request (Anthropic and DashScope both at 4)
      // and silently ignore markers beyond the cap, so when the budget is
      // already spent we evict the least valuable marker: the fork boundary
      // only matters for the first subagent request, while the rolling block
      // protects the entire conversation history every turn.
      if (messages.length >= 2) {
        const markers = collectCacheMarkers(system, messages);
        if (markers.length < MAX_CACHE_MARKERS) {
          markLastBlock(messages[messages.length - 1]!);
        } else if (markers.length > 2) {
          stripCacheControl(markers[markers.length - 2]!);
          markLastBlock(messages[messages.length - 1]!);
        }
      }
      // Request shape captured for FLAVOR_DEBUG_USAGE cache diagnostics.
      requestShape = {
        messages: messages.length,
        markers: collectCacheMarkers(system, messages).length,
      };

      const body: MessageCreateParamsStreaming = {
        model: request.model,
        max_tokens: this.maxOutputTokens,
        stream: true,
        messages,
        ...(system ? { system } : {}),
        tools: [...request.tools].sort((a, b) => a.name.localeCompare(b.name)).map((tool) => ({
          name: tool.name,
          description: tool.description,
          input_schema: { ...tool.inputSchema, type: "object" as const },
        })),
      };
      const stream = await this.client.messages.create(body, { signal: request.signal });

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
          this.#logUsage(request, inputUsage, requestShape);
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
            try {
              const input = normalizeToolCallInput(pending.json || "{}");
              yield { type: "tool-call", id: pending.id, name: pending.name, input };
            } catch (error) {
              const detail = error instanceof Error ? error.message : String(error);
              yield {
                type: "invalid-tool-call",
                id: pending.id,
                name: pending.name,
                rawInput: pending.json,
                error: {
                  code: "invalid_tool_arguments",
                  message: `Invalid tool-call input for "${pending.name}": ${detail}`,
                },
              };
            }
          }
          usageEmitted = true;
          yield { type: "usage", ...usage };
          yield { type: "done", usage };
        }
      }
    } catch (error) {
      if (hasUsage && !usageEmitted) {
        this.#logUsage(request, inputUsage, requestShape);
        yield { type: "usage", inputTokens, outputTokens };
      }
      yield { type: "error", error: normalizeProviderError(error) };
    }
  }
}
