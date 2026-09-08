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
  /** Provider-facing schema when runtime validation was derived from another source (for example MCP). */
  modelInputSchema?: Record<string, unknown>;
  /** Preserve the original tool's provider strictness during argument repair. */
  modelStrict?: boolean;
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
  | { type: "attempt-start"; attempt: number; maxAttempts: number }
  | { type: "attempt-end"; attempt: number; maxAttempts: number }
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

  const generatedTool = options.modelInputSchema === undefined
    ? modelToolFromZod(options.name, options.description, options.schema)
    : { name: options.name, description: options.description, inputSchema: options.modelInputSchema };
  const tool: ModelTool = options.modelStrict === undefined
    ? generatedTool
    : { ...generatedTool, strict: options.modelStrict };
  const maxAttempts = retry.maxRetries + 1;
  const validationSchema = jsonSchemaFromZod(options.schema);

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
        yield { type: "attempt-start", attempt, maxAttempts };

        candidate = undefined;
        rawCandidate = undefined;
        let candidateCount = 0;
        let textCandidate = "";
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
          } else if (event.type === "text") {
            textCandidate += event.text;
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
          if (candidateCount === 0 && textCandidate.trim() !== "") {
            // Some providers answer the repair prompt with JSON as plain text
            // instead of a tool call. Accept it as the candidate.
            const extracted = extractJsonObject(textCandidate);
            if (extracted !== undefined) {
              candidate = extracted;
              candidateCount = 1;
              rawCandidate = textCandidate;
            }
          }
          if (candidateCount === 1 && candidate !== null && typeof candidate === "object") {
            // Providers may serialize typed fields as strings; normalize before
            // schema validation so a coercible payload does not burn a retry.
            candidate = coerceByJsonSchema(candidate, validationSchema);
          }
          if (candidateCount !== 1) {
            attemptError = {
              code: "invalid_tool_arguments",
              message: `Expected exactly one structured output tool call; received ${candidateCount}`,
            };
          } else {
            const parsed = options.schema.safeParse(candidate);
            if (parsed.success) {
              await options.afterAttempt?.({ ...attemptInfo, completed: true });
              yield { type: "attempt-end", attempt, maxAttempts };
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
        yield { type: "attempt-end", attempt, maxAttempts };
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
  return strictJsonSchemaObject(jsonSchemaFromZod(schema));
}

/** Runtime-facing JSON Schema before provider strictness rewrites optional fields. */
export function jsonSchemaFromZod(schema: z.ZodType<unknown>): Record<string, unknown> {
  return z.toJSONSchema(schema) as Record<string, unknown>;
}

/** Recursively adapts an existing JSON Schema for providers that require strict function tools. */
export function strictJsonSchemaObject(schema: Record<string, unknown>): Record<string, unknown> {
  return normalizeOpenAIJsonSchemaObject(schema, true);
}

/**
 * Normalize a function-tool schema to the JSON Schema subset accepted by the
 * OpenAI Responses API and strict OpenAI-compatible gateways. Non-strict mode
 * keeps open objects, but still removes unsupported annotations and keywords
 * that providers validate before the model call starts.
 */
export function openAIJsonSchemaObject(
  schema: Record<string, unknown>,
  strict: boolean,
): Record<string, unknown> {
  return normalizeOpenAIJsonSchemaObject(schema, strict);
}

/**
 * Extract the first JSON object or array from free-form model text (plain JSON,
 * fenced ```json blocks, or JSON embedded in prose). Returns undefined when no
 * parseable object is found.
 */
export function extractJsonObject(text: string): unknown {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/u);
  const candidates = fenced !== null && fenced[1] !== undefined ? [fenced[1].trim(), trimmed] : [trimmed];
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (parsed !== null && typeof parsed === "object") return parsed;
    } catch { /* try the next candidate */ }
  }
  const start = trimmed.indexOf("{");
  if (start >= 0) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < trimmed.length; index += 1) {
      const char = trimmed[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === "\"") inString = false;
        continue;
      }
      if (char === "\"") inString = true;
      else if (char === "{") depth += 1;
      else if (char === "}") {
        depth -= 1;
        if (depth === 0) {
          try {
            const parsed = JSON.parse(trimmed.slice(start, index + 1)) as unknown;
            if (parsed !== null && typeof parsed === "object") return parsed;
          } catch { return undefined; }
        }
      }
    }
  }
  return undefined;
}

/**
 * Best-effort type coercion guided by a JSON schema. Some providers serialize
 * typed fields as strings (`"10"` for an integer) or collapse a single-item
 * array to its item (`"main"` instead of `["main"]`). This rewrites those
 * provider representations where the schema demands another type, recursing
 * into object properties and anyOf branches. Values already matching the
 * schema are returned unchanged, so a valid payload is a no-op.
 */
export function coerceByJsonSchema(value: unknown, schema: unknown): unknown {
  if (schema === null || schema === undefined || typeof schema !== "object") return value;
  const node = schema as Record<string, unknown>;
  const branches = [
    ...(Array.isArray(node.anyOf) ? node.anyOf : []) as unknown[],
    ...(Array.isArray(node.oneOf) ? node.oneOf : []) as unknown[],
    ...(Array.isArray(node.allOf) ? node.allOf : []) as unknown[],
  ].filter((branch): branch is Record<string, unknown> => branch !== null && typeof branch === "object");

  const types: string[] = [];
  const pushTypes = (candidate: Record<string, unknown>) => {
    if (typeof candidate.type === "string") types.push(candidate.type);
    else if (Array.isArray(candidate.type)) types.push(...(candidate.type as string[]));
  };
  pushTypes(node);
  for (const branch of branches) pushTypes(branch);

  if (types.includes("null") && (value === null || value === undefined)) return value;

  if ((types.includes("number") || types.includes("integer")) && typeof value === "string" && value.trim() !== "") {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric;
  }
  if (types.includes("boolean") && typeof value === "string") {
    const lowered = value.trim().toLowerCase();
    if (lowered === "true") return true;
    if (lowered === "false") return false;
  }
  if (types.includes("object") && !types.includes("string") && typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.startsWith("{")) {
      try {
        const parsed = JSON.parse(trimmed) as unknown;
        if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
          return coerceByJsonSchema(parsed, node);
        }
      } catch { /* Leave malformed JSON for normal validation and repair. */ }
    }
  }
  if (
    types.includes("array")
    && !Array.isArray(value)
    && value !== null
    && value !== undefined
    && !types.some((type) => matchesJsonSchemaType(value, type))
  ) {
    const arraySchema = [node, ...branches].find((candidate) => {
      const type = candidate.type;
      return type === "array" || (Array.isArray(type) && type.includes("array"));
    });
    if (typeof value === "string" && value.trim().startsWith("[")) {
      try {
        const parsed = JSON.parse(value.trim()) as unknown;
        if (Array.isArray(parsed)) return coerceByJsonSchema(parsed, arraySchema ?? node);
      } catch { /* Treat a non-JSON value as one array item. */ }
    }
    return [arraySchema?.items === undefined
      ? value
      : coerceByJsonSchema(value, arraySchema.items)];
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const objectSchema = [node, ...branches].find((candidate) =>
      candidate.type === "object" || candidate.properties !== undefined);
    const properties = objectSchema?.properties as Record<string, unknown> | undefined;
    if (properties !== undefined) {
      const output: Record<string, unknown> = {};
      const required = new Set(Array.isArray(objectSchema?.required) ? objectSchema.required as string[] : []);
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        const childSchema = properties[key];
        if (child === null && childSchema !== undefined && !required.has(key) && !jsonSchemaAllowsNull(childSchema)) {
          continue;
        }
        output[key] = childSchema !== undefined ? coerceByJsonSchema(child, childSchema) : child;
      }
      return output;
    }
  }
  if (types.includes("array") && Array.isArray(value)) {
    const arraySchema = [node, ...branches].find((candidate) => {
      const type = candidate.type;
      return type === "array" || (Array.isArray(type) && type.includes("array"));
    });
    if (arraySchema?.items !== undefined) {
      return value.map((item) => coerceByJsonSchema(item, arraySchema.items));
    }
  }
  return value;
}

function matchesJsonSchemaType(value: unknown, type: string): boolean {
  if (type === "null") return value === null;
  if (type === "array") return Array.isArray(value);
  if (type === "object") return value !== null && typeof value === "object" && !Array.isArray(value);
  if (type === "integer") return typeof value === "number" && Number.isInteger(value);
  if (type === "number") return typeof value === "number";
  return typeof value === type;
}

function jsonSchemaAllowsNull(schema: unknown): boolean {
  if (schema === null || typeof schema !== "object") return false;
  const node = schema as Record<string, unknown>;
  if (node.type === "null" || (Array.isArray(node.type) && node.type.includes("null"))) return true;
  return [node.anyOf, node.oneOf].some((branches) =>
    Array.isArray(branches) && branches.some((branch) => jsonSchemaAllowsNull(branch)));
}

export function modelToolFromZod(
  name: string,
  description: string,
  schema: z.ZodType<unknown>,
): ModelTool {
  return { name, description, inputSchema: strictJsonSchema(schema) };
}

const JSON_SCHEMA_TYPES = new Set(["null", "boolean", "object", "array", "number", "string", "integer"]);
const OPENAI_UNSUPPORTED_SCHEMA_KEYWORDS = [
  "$schema", "$id", "$anchor", "$dynamicAnchor", "$dynamicRef", "$comment",
  "default", "examples", "example", "deprecated", "readOnly", "writeOnly",
  "format", "propertyNames", "patternProperties", "unevaluatedProperties",
  "unevaluatedItems", "additionalItems", "contains", "minContains", "maxContains",
  "uniqueItems", "minProperties", "maxProperties", "contentEncoding", "contentMediaType",
  "not", "if", "then", "else", "dependentRequired", "dependentSchemas", "dependencies",
] as const;

function normalizeOpenAIJsonSchemaObject(
  schema: Record<string, unknown>,
  strict: boolean,
): Record<string, unknown> {
  const normalized = normalizeOpenAIJsonSchemaNode(schema, strict);
  if (normalized.type === "object") return normalized;
  // Function arguments are always objects. A malformed third-party root must
  // not poison the registration of every other tool in the same API request.
  return strict
    ? { type: "object", properties: {}, required: [], additionalProperties: false }
    : { type: "object", properties: {}, additionalProperties: true };
}

function normalizeOpenAIJsonSchemaNode(
  rawSchema: Record<string, unknown>,
  strict: boolean,
): Record<string, unknown> {
  const schema = mergeObjectAllOf(rawSchema);
  const output: Record<string, unknown> = { ...schema };
  for (const keyword of OPENAI_UNSUPPORTED_SCHEMA_KEYWORDS) delete output[keyword];
  delete output.oneOf;
  delete output.allOf;
  delete output.prefixItems;
  delete output.nullable;
  delete output.definitions;
  if (typeof output.$ref === "string" && output.$ref.startsWith("#/definitions/")) {
    output.$ref = output.$ref.replace("#/definitions/", "#/$defs/");
  }

  const compositionBranches = [
    ...(Array.isArray(schema.anyOf) ? schema.anyOf : []),
    ...(Array.isArray(schema.oneOf) ? schema.oneOf : []),
    ...(Array.isArray(schema.allOf) ? schema.allOf : []),
  ];
  if (compositionBranches.length > 0) {
    output.anyOf = compositionBranches.map((branch) => normalizeOpenAISchemaValue(branch, strict));
  } else {
    delete output.anyOf;
  }

  const definitions = {
    ...(isSchemaRecord(schema.definitions) ? schema.definitions : {}),
    ...(isSchemaRecord(schema.$defs) ? schema.$defs : {}),
  };
  if (Object.keys(definitions).length > 0) {
    output.$defs = Object.fromEntries(Object.entries(definitions)
      .map(([key, definition]) => [key, normalizeOpenAISchemaValue(definition, strict)]));
  }

  const prefixItems = Array.isArray(schema.prefixItems) ? schema.prefixItems : undefined;
  if (prefixItems !== undefined && prefixItems.length > 0) {
    const tupleItems = prefixItems.map((item) => normalizeOpenAISchemaValue(item, strict));
    output.items = tupleItems.length === 1 ? tupleItems[0] : { anyOf: tupleItems };
  } else if (Array.isArray(schema.items)) {
    const tupleItems = schema.items.map((item) => normalizeOpenAISchemaValue(item, strict));
    output.items = tupleItems.length === 1 ? tupleItems[0] : { anyOf: tupleItems };
  } else if (isSchemaRecord(schema.items)) {
    output.items = normalizeOpenAIJsonSchemaNode(schema.items, strict);
  } else if (schema.items === true || schema.items === false) {
    output.items = universalJsonValueSchema(strict);
  }

  let type = schema.type;
  if (type === undefined && isSchemaRecord(schema.properties)) type = "object";
  if (type === undefined && output.items !== undefined) type = "array";
  if (type === undefined && Array.isArray(schema.enum)) type = inferJsonTypes(schema.enum);
  if (type === undefined && Object.hasOwn(schema, "const")) type = inferJsonTypes([schema.const]);
  if (typeof type === "string" && !JSON_SCHEMA_TYPES.has(type)) type = undefined;
  if (Array.isArray(type)) {
    const types = type.filter((candidate) => typeof candidate === "string" && JSON_SCHEMA_TYPES.has(candidate));
    type = types.length === 0 ? undefined : types;
  }
  delete output.type;
  if (type !== undefined) output.type = type;
  if (schemaTypeIncludes(type, "array") && output.items === undefined) {
    output.items = universalJsonValueSchema(strict);
  }

  if (schemaTypeIncludes(type, "object")) {
    const sourceProperties = isSchemaRecord(schema.properties) ? schema.properties : {};
    const sourceRequired = new Set(Array.isArray(schema.required)
      ? schema.required.filter((key): key is string => typeof key === "string")
      : []);
    const properties: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(sourceProperties)) {
      const child = normalizeOpenAISchemaValue(value, strict);
      if (!strict || sourceRequired.has(key) || jsonSchemaAllowsNull(child)) properties[key] = child;
      else properties[key] = { anyOf: [child, { type: "null" }] };
      if (strict) sourceRequired.add(key);
    }
    output.properties = properties;
    const required = strict
      ? Object.keys(properties)
      : [...sourceRequired].filter((key) => Object.hasOwn(properties, key));
    if (strict || required.length > 0 || Array.isArray(schema.required)) output.required = required;
    else delete output.required;
    if (strict) {
      output.additionalProperties = false;
    } else if (schema.additionalProperties === true || schema.additionalProperties === false) {
      output.additionalProperties = schema.additionalProperties;
    } else if (isSchemaRecord(schema.additionalProperties)) {
      output.additionalProperties = Object.keys(schema.additionalProperties).length === 0
        ? true
        : normalizeOpenAIJsonSchemaNode(schema.additionalProperties, false);
    } else {
      delete output.additionalProperties;
    }
  }

  if (schema.nullable === true && !jsonSchemaAllowsNull(output)) {
    const description = typeof output.description === "string" ? output.description : undefined;
    const branch = { ...output };
    delete branch.description;
    return {
      ...(description === undefined ? {} : { description }),
      anyOf: [branch, { type: "null" }],
    };
  }

  if (isTypedOrComposedSchema(output)) return output;
  return universalJsonValueSchema(strict);
}

function mergeObjectAllOf(schema: Record<string, unknown>): Record<string, unknown> {
  const branches = Array.isArray(schema.allOf) ? schema.allOf.filter(isSchemaRecord) : [];
  if (branches.length === 0 || !branches.every(isObjectSchema)) return schema;

  const base: Record<string, unknown> = { ...schema };
  delete base.allOf;
  const properties: Record<string, unknown> = isSchemaRecord(base.properties) ? { ...base.properties } : {};
  const required = new Set(Array.isArray(base.required)
    ? base.required.filter((key): key is string => typeof key === "string")
    : []);
  for (const branch of branches) {
    if (isSchemaRecord(branch.properties)) {
      for (const [key, value] of Object.entries(branch.properties)) {
        const existing = properties[key];
        properties[key] = existing === undefined ? value : { anyOf: [existing, value] };
      }
    }
    if (Array.isArray(branch.required)) {
      for (const key of branch.required) if (typeof key === "string") required.add(key);
    }
  }
  return { ...base, type: "object", properties, required: [...required] };
}

function normalizeOpenAISchemaValue(value: unknown, strict: boolean): Record<string, unknown> {
  if (isSchemaRecord(value)) return normalizeOpenAIJsonSchemaNode(value, strict);
  return universalJsonValueSchema(strict);
}

function universalJsonValueSchema(strict: boolean): Record<string, unknown> {
  const scalar = [{ type: "string" }, { type: "number" }, { type: "boolean" }, { type: "null" }];
  return {
    anyOf: [
      ...scalar,
      strict
        ? { type: "object", properties: {}, required: [], additionalProperties: false }
        : { type: "object", properties: {}, additionalProperties: true },
      { type: "array", items: { anyOf: scalar } },
    ],
  };
}

function inferJsonTypes(values: unknown[]): string | string[] | undefined {
  const types = [...new Set(values.map((value) => {
    if (value === null) return "null";
    if (Array.isArray(value)) return "array";
    if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
    if (typeof value === "object") return "object";
    return typeof value;
  }).filter((type) => ["null", "array", "object", "integer", "number", "string", "boolean"].includes(type)))];
  return types.length === 0 ? undefined : (types.length === 1 ? types[0] : types);
}

function isSchemaRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isObjectSchema(schema: Record<string, unknown>): boolean {
  return schema.type === "object" || isSchemaRecord(schema.properties);
}

function isTypedOrComposedSchema(schema: Record<string, unknown>): boolean {
  return typeof schema.type === "string"
    || Array.isArray(schema.type)
    || typeof schema.$ref === "string"
    || Array.isArray(schema.anyOf);
}

function schemaTypeIncludes(type: unknown, expected: string): boolean {
  return type === expected || (Array.isArray(type) && type.includes(expected));
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
