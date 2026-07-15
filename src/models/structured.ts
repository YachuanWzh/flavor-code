import { z } from "zod";

import type { ModelRegistry } from "./registry.js";
import type {
  ModelEvent,
  ModelMessage,
  ModelRequest,
  ModelTool,
  ProviderError,
} from "./types.js";

const DEFAULT_RETRY_DELAYS = [1_000, 2_000, 4_000] as const;

export interface StructuredOutputRetryPolicy {
  maxRetries: number;
  backoffMs: readonly number[];
}

export interface StructuredOutputOptions<T> {
  registry: ModelRegistry;
  modelId: string;
  name: string;
  description: string;
  schema: z.ZodType<T>;
  retry?: StructuredOutputRetryPolicy;
  beforeAttempt?(attempt: StructuredOutputAttempt): void | Promise<void>;
  afterAttempt?(attempt: StructuredOutputAttemptResult): void | Promise<void>;
}

export interface StructuredOutputAttempt {
  modelId: string;
  attempt: number;
  maxAttempts: number;
  messageCount: number;
}

export interface StructuredOutputAttemptResult extends StructuredOutputAttempt {
  completed: boolean;
  error?: ProviderError;
}

export interface StructuredOutputRequest {
  messages: ModelMessage[];
  invalidOutput?: string;
  validationError?: string;
  signal?: AbortSignal;
}

export type StructuredOutputEvent<T> =
  | { type: "usage"; inputTokens: number; outputTokens: number }
  | {
    type: "retry";
    attempt: number;
    maxAttempts: number;
    delayMs: number;
    error: string;
  }
  | { type: "output"; value: T; attempts: number };

export interface StructuredOutputResult<T> {
  value: T;
  usage: { inputTokens: number; outputTokens: number };
  attempts: number;
}

export interface StructuredModel<T> {
  stream(request: StructuredOutputRequest): AsyncIterable<StructuredOutputEvent<T>>;
  invoke(request: StructuredOutputRequest): Promise<StructuredOutputResult<T>>;
}

export class StructuredOutputError extends Error {
  readonly code = "structured_output_error" as const;

  constructor(message: string) {
    super(message);
    this.name = "StructuredOutputError";
  }
}

export function withStructuredOutput<T>(options: StructuredOutputOptions<T>): StructuredModel<T> {
  const retry = options.retry ?? {
    maxRetries: DEFAULT_RETRY_DELAYS.length,
    backoffMs: DEFAULT_RETRY_DELAYS,
  };
  if (!Number.isInteger(retry.maxRetries) || retry.maxRetries < 0) {
    throw new Error("Structured output maxRetries must be a non-negative integer");
  }
  if (retry.backoffMs.length < retry.maxRetries) {
    throw new Error("Structured output backoffMs must provide one delay per retry");
  }
  for (const delay of retry.backoffMs.slice(0, retry.maxRetries)) {
    if (!Number.isSafeInteger(delay) || delay < 0) {
      throw new Error("Structured output retry delays must be non-negative integers");
    }
  }

  const tool = modelToolFromZod(options.name, options.description, options.schema);
  const maxAttempts = retry.maxRetries + 1;

  const model: StructuredModel<T> = {
    async *stream(request) {
      let candidate: unknown;
      let rawCandidate: string | undefined;
      let lastError = request.validationError ?? "The prior output was not valid structured data";
      const secrets = new Set<string>();
      if (request.invalidOutput) secrets.add(request.invalidOutput);

      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        request.signal?.throwIfAborted();
        const { adapter, model: providerModel } = options.registry.get(options.modelId);
        const modelRequest: ModelRequest = {
          model: providerModel,
          messages: repairMessages(
            request.messages,
            tool,
            request.invalidOutput,
            attempt > 1 ? rawCandidate ?? candidateText(candidate) : undefined,
            lastError,
          ),
          tools: [tool],
          ...(request.signal === undefined ? {} : { signal: request.signal }),
        };

        const attemptInfo: StructuredOutputAttempt = {
          modelId: options.modelId,
          attempt,
          maxAttempts,
          messageCount: modelRequest.messages.length,
        };
        await options.beforeAttempt?.(attemptInfo);

        candidate = undefined;
        rawCandidate = undefined;
        let candidateCount = 0;
        let attemptError: ProviderError | undefined;
        let usage: { inputTokens: number; outputTokens: number } | undefined;

        for await (const event of adapter.stream(modelRequest)) {
          if (event.type === "tool-call") {
            if (event.name !== options.name) {
              attemptError = {
                code: "invalid_tool_arguments",
                message: `Expected structured output tool "${options.name}" but received "${event.name}"`,
              };
              continue;
            }
            candidateCount += 1;
            candidate = event.input;
          } else if (event.type === "invalid-tool-call") {
            rawCandidate = event.rawInput;
            secrets.add(event.rawInput);
            attemptError = event.error;
          } else if (event.type === "usage") {
            usage = { inputTokens: event.inputTokens, outputTokens: event.outputTokens };
          } else if (event.type === "done") {
            usage = event.usage;
          } else if (event.type === "error") {
            attemptError = event.error;
          }
        }

        if (usage !== undefined) yield { type: "usage", ...usage };

        if (attemptError === undefined) {
          if (candidateCount !== 1) {
            attemptError = {
              code: "invalid_tool_arguments",
              message: `Expected exactly one structured output tool call; received ${candidateCount}`,
            };
          } else {
            const parsed = options.schema.safeParse(candidate);
            if (parsed.success) {
              await options.afterAttempt?.({ ...attemptInfo, completed: true });
              yield { type: "output", value: parsed.data, attempts: attempt };
              return;
            }
            rawCandidate = candidateText(candidate);
            if (rawCandidate) secrets.add(rawCandidate);
            attemptError = {
              code: "invalid_tool_arguments",
              message: parsed.error.message,
            };
          }
        }

        lastError = attemptError.message;
        await options.afterAttempt?.({
          ...attemptInfo,
          completed: false,
          error: { ...attemptError, message: sanitize(attemptError.message, secrets) },
        });
        if (attempt >= maxAttempts) {
          throw new StructuredOutputError(
            sanitize(
              `Structured output for "${options.name}" failed after ${maxAttempts} attempts: ${lastError}`,
              secrets,
            ),
          );
        }

        const delayMs = retry.backoffMs[attempt - 1]!;
        yield {
          type: "retry",
          attempt: attempt + 1,
          maxAttempts,
          delayMs,
          error: sanitize(lastError, secrets),
        };
        await waitForRetry(delayMs, request.signal);
      }
    },

    async invoke(request) {
      let value: T | undefined;
      let attempts = 0;
      let inputTokens = 0;
      let outputTokens = 0;
      for await (const event of model.stream(request)) {
        if (event.type === "usage") {
          inputTokens += event.inputTokens;
          outputTokens += event.outputTokens;
        } else if (event.type === "output") {
          value = event.value;
          attempts = event.attempts;
        }
      }
      if (value === undefined) {
        throw new StructuredOutputError(`Structured output for "${options.name}" ended without a value`);
      }
      return { value, usage: { inputTokens, outputTokens }, attempts };
    },
  };

  return model;
}

export function strictJsonSchema(schema: z.ZodType<unknown>): Record<string, unknown> {
  return ensureStrictSchema(z.toJSONSchema(schema) as Record<string, unknown>);
}

export function modelToolFromZod(
  name: string,
  description: string,
  schema: z.ZodType<unknown>,
): ModelTool {
  return { name, description, inputSchema: strictJsonSchema(schema) };
}

function ensureStrictSchema(schema: Record<string, unknown>): Record<string, unknown> {
  if (schema.type !== "object" || typeof schema.properties !== "object" || schema.properties === null) {
    return schema;
  }
  const required = Array.isArray(schema.required) ? [...schema.required] as string[] : [];
  const requiredSet = new Set(required);
  const properties: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema.properties)) {
    const child = typeof value === "object" && value !== null
      ? ensureStrictSchema(value as Record<string, unknown>)
      : value;
    if (requiredSet.has(key)) properties[key] = child;
    else {
      properties[key] = { anyOf: [child, { type: "null" }] };
      requiredSet.add(key);
    }
  }
  return { ...schema, additionalProperties: false, required: [...requiredSet], properties };
}

function repairMessages(
  messages: readonly ModelMessage[],
  tool: ModelTool,
  original: string | undefined,
  candidate: string | undefined,
  error: string,
): ModelMessage[] {
  const details = [
    `Repair the arguments for tool "${tool.name}".`,
    "Return exactly one call to that tool. Do not add fields or change the original intent.",
    `JSON Schema:\n${JSON.stringify(tool.inputSchema)}`,
    ...(original === undefined ? [] : [`Original invalid output:\n${original}`]),
    ...(candidate === undefined ? [] : [`Most recent invalid candidate:\n${candidate}`]),
    `Validation error:\n${error}`,
  ].join("\n\n");
  return [...messages, { role: "system", content: details }];
}

function candidateText(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  try { return JSON.stringify(value) ?? String(value); }
  catch { return String(value); }
}

function sanitize(message: string, secrets: ReadonlySet<string>): string {
  let safe = message;
  for (const secret of secrets) {
    if (secret) safe = safe.replaceAll(secret, "[redacted]");
  }
  return safe;
}

function waitForRetry(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason);
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
