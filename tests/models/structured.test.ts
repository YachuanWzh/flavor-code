import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { ModelRegistry } from "../../src/models/registry.js";
import { withStructuredOutput } from "../../src/models/structured.js";
import type { ModelAdapter, ModelEvent, ModelRequest } from "../../src/models/types.js";

afterEach(() => vi.useRealTimers());

describe("withStructuredOutput", () => {
  it("returns a typed Zod value through one strict synthetic tool", async () => {
    const requests: ModelRequest[] = [];
    const registry = registryWith(fakeAdapter([[
      { type: "tool-call", id: "repair-1", name: "Read", input: { path: "C:\\Users\\wangzh" } },
      { type: "usage", inputTokens: 3, outputTokens: 2 },
      { type: "done", usage: { inputTokens: 3, outputTokens: 2 } },
    ]], requests));
    const model = withStructuredOutput({
      registry,
      modelId: "cheap:model",
      name: "Read",
      description: "Read a file",
      schema: z.object({ path: z.string() }).strict(),
    });

    const result = await model.invoke({
      messages: [{ role: "user", content: "Repair the input" }],
      invalidOutput: String.raw`{"path":"C:\Users\wangzh"}`,
      validationError: "Bad escaped character at position 12",
    });

    expect(result).toEqual({
      value: { path: "C:\\Users\\wangzh" },
      usage: { inputTokens: 3, outputTokens: 2 },
      attempts: 1,
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.tools).toEqual([expect.objectContaining({
      name: "Read",
      inputSchema: expect.objectContaining({
        type: "object",
        additionalProperties: false,
        required: ["path"],
      }),
    })]);
  });

  it("feeds a schema-invalid candidate and Zod error into the next request", async () => {
    vi.useFakeTimers();
    const requests: ModelRequest[] = [];
    const registry = registryWith(fakeAdapter([
      [
        { type: "tool-call", id: "repair-1", name: "Read", input: { path: 42 } },
        { type: "usage", inputTokens: 2, outputTokens: 1 },
        { type: "done", usage: { inputTokens: 2, outputTokens: 1 } },
      ],
      [
        { type: "tool-call", id: "repair-2", name: "Read", input: { path: "notes.md" } },
        { type: "usage", inputTokens: 3, outputTokens: 2 },
        { type: "done", usage: { inputTokens: 3, outputTokens: 2 } },
      ],
    ], requests));
    const model = withStructuredOutput({
      registry,
      modelId: "cheap:model",
      name: "Read",
      description: "Read a file",
      schema: z.object({ path: z.string() }).strict(),
    });

    const resultPromise = model.invoke({
      messages: [{ role: "user", content: "Repair the input" }],
      invalidOutput: "{broken",
      validationError: "Unexpected end of JSON input",
    });
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(result).toEqual({
      value: { path: "notes.md" },
      usage: { inputTokens: 5, outputTokens: 3 },
      attempts: 2,
    });
    const feedback = requests[1]?.messages.map(({ content }) => content).join("\n") ?? "";
    expect(feedback).toContain('{"path":42}');
    expect(feedback).toMatch(/path|string/i);
  });

  it("makes one initial call plus three retries with 1s, 2s, and 4s backoff", async () => {
    vi.useFakeTimers();
    const requests: ModelRequest[] = [];
    const invalid = (index: number): ModelEvent[] => [
      {
        type: "invalid-tool-call",
        id: `repair-${index}`,
        name: "Read",
        rawInput: `{broken-${index}`,
        error: { code: "invalid_tool_arguments", message: `parse failed for {broken-${index}` },
      },
      { type: "done", usage: { inputTokens: 1, outputTokens: 1 } },
    ];
    const registry = registryWith(fakeAdapter([invalid(1), invalid(2), invalid(3), invalid(4)], requests));
    const auditedErrors: string[] = [];
    const model = withStructuredOutput({
      registry,
      modelId: "cheap:model",
      name: "Read",
      description: "Read a file",
      schema: z.object({ path: z.string() }).strict(),
      afterAttempt: ({ error }) => {
        if (error !== undefined) auditedErrors.push(error.message);
      },
    });

    const retries: number[] = [];
    const run = (async () => {
      for await (const event of model.stream({
        messages: [{ role: "user", content: "Repair" }],
        invalidOutput: "original-secret-payload",
        validationError: "original-error",
      })) {
        if (event.type === "retry") retries.push(event.delayMs);
      }
    })();
    const rejection = expect(run).rejects.toThrow(/structured output.*4 attempts/i);
    await vi.runAllTimersAsync();
    await rejection;

    expect(requests).toHaveLength(4);
    expect(retries).toEqual([1_000, 2_000, 4_000]);
    expect(auditedErrors).toHaveLength(4);
    expect(auditedErrors.join("\n")).not.toMatch(/\{broken-/);
    await expect(run).rejects.not.toThrow(/original-secret-payload/);
  });

  it("accepts a text-only JSON answer from the repair model and coerces string numbers", async () => {
    const requests: ModelRequest[] = [];
    const registry = registryWith(fakeAdapter([[
      { type: "text", text: "Sure, here are the repaired arguments:\n{\"query\":\"ast 实现\",\"limit\":\"10\"}" },
      { type: "usage", inputTokens: 3, outputTokens: 2 },
      { type: "done", usage: { inputTokens: 3, outputTokens: 2 } },
    ]], requests));
    const model = withStructuredOutput({
      registry,
      modelId: "cheap:model",
      name: "ast_search",
      description: "Search",
      schema: z.object({
        query: z.string(),
        limit: z.number().int().min(1).max(50).optional(),
      }),
    });

    const result = await model.invoke({
      messages: [{ role: "user", content: "Repair the invalid arguments for tool \"ast_search\"." }],
      invalidOutput: "{\"query\":\"ast 实现\",\"limit\":\"10\"}",
      validationError: "Expected number, received string",
    });

    expect(result).toEqual({
      value: { query: "ast 实现", limit: 10 },
      usage: { inputTokens: 3, outputTokens: 2 },
      attempts: 1,
    });
  });

  it("coerces string-serialized numbers against the tool JSON schema", async () => {
    const { coerceByJsonSchema } = await import("../../src/models/structured.js");
    const schema = {
      type: "object",
      additionalProperties: false,
      required: ["query", "limit"],
      properties: {
        query: { type: "string" },
        limit: { anyOf: [{ type: "integer" }, { type: "null" }] },
      },
    };
    expect(coerceByJsonSchema({ query: "x", limit: "10" }, schema)).toEqual({ query: "x", limit: 10 });
    expect(coerceByJsonSchema({ query: "x", limit: 5 }, schema)).toEqual({ query: "x", limit: 5 });
    expect(coerceByJsonSchema({ query: "x", limit: null }, schema)).toEqual({ query: "x", limit: null });
    expect(coerceByJsonSchema({ query: "x", limit: "ten" }, schema)).toEqual({ query: "x", limit: "ten" });
  });

  it("strictifies nested optional fields and drops provider nulls before runtime validation", async () => {
    const requests: ModelRequest[] = [];
    const schema = z.object({
      tasks: z.array(z.object({
        subject: z.string(),
        result: z.string().optional(),
      }).strict()),
      limit: z.number().int().optional(),
    }).strict();
    const registry = registryWith(fakeAdapter([[
      {
        type: "tool-call",
        id: "repair-1",
        name: "TaskPlan",
        input: { tasks: [{ subject: "audit", result: null }], limit: null },
      },
      { type: "done", usage: { inputTokens: 1, outputTokens: 1 } },
    ]], requests));
    const model = withStructuredOutput({
      registry,
      modelId: "cheap:model",
      name: "TaskPlan",
      description: "Plan tasks",
      schema,
    });

    await expect(model.invoke({ messages: [{ role: "user", content: "Repair" }] })).resolves.toMatchObject({
      value: { tasks: [{ subject: "audit" }] },
      attempts: 1,
    });
    const toolSchema = requests[0]?.tools[0]?.inputSchema;
    expect(toolSchema).toMatchObject({
      required: expect.arrayContaining(["tasks", "limit"]),
      properties: {
        tasks: {
          items: {
            required: expect.arrayContaining(["subject", "result"]),
            properties: { result: { anyOf: expect.arrayContaining([{ type: "null" }]) } },
          },
        },
      },
    });
  });

  it("restores collapsed arrays and JSON-serialized objects without changing fields that allow their original type", async () => {
    const { coerceByJsonSchema } = await import("../../src/models/structured.js");
    const schema = {
      type: "object",
      additionalProperties: false,
      required: ["agents", "optionalAgents", "questions", "stringOrArray"],
      properties: {
        agents: { type: "array", items: { type: "string", enum: ["main", "subagent"] } },
        optionalAgents: {
          anyOf: [
            { type: "array", items: { type: "integer" } },
            { type: "null" },
          ],
        },
        questions: {
          type: "array",
          items: {
            type: "object",
            required: ["count"],
            properties: { count: { type: "integer" } },
          },
        },
        stringOrArray: {
          anyOf: [
            { type: "string" },
            { type: "array", items: { type: "string" } },
          ],
        },
      },
    };

    expect(coerceByJsonSchema({
      agents: "main",
      optionalAgents: "[\"1\",\"2\"]",
      questions: "{\"count\":\"1\"}",
      stringOrArray: "keep me",
    }, schema)).toEqual({
      agents: ["main"],
      optionalAgents: [1, 2],
      questions: [{ count: 1 }],
      stringOrArray: "keep me",
    });
  });

  it("uses a supplied provider schema and strictness for dynamic-tool repair", async () => {
    const requests: ModelRequest[] = [];
    const providerSchema = {
      type: "object",
      properties: { values: { oneOf: [{ type: "array", items: { type: "integer" } }, { type: "null" }] } },
      required: ["values"],
    };
    const registry = registryWith(fakeAdapter([[
      { type: "tool-call", id: "repair-1", name: "Dynamic", input: { values: "1" } },
      { type: "done", usage: { inputTokens: 1, outputTokens: 1 } },
    ]], requests));
    const model = withStructuredOutput({
      registry,
      modelId: "cheap:model",
      name: "Dynamic",
      description: "Dynamic tool",
      schema: z.object({ values: z.array(z.number().int()).nullable() }),
      modelInputSchema: providerSchema,
      modelStrict: false,
    });

    await expect(model.invoke({ messages: [{ role: "user", content: "Repair" }] })).resolves.toMatchObject({
      value: { values: [1] },
      attempts: 1,
    });
    expect(requests[0]?.tools).toEqual([{
      name: "Dynamic",
      description: "Dynamic tool",
      inputSchema: providerSchema,
      strict: false,
    }]);
  });

  it("cancels during backoff without making another model call", async () => {
    vi.useFakeTimers();
    const requests: ModelRequest[] = [];
    const registry = registryWith(fakeAdapter([[
      {
        type: "invalid-tool-call",
        id: "repair-1",
        name: "Read",
        rawInput: "{broken",
        error: { code: "invalid_tool_arguments", message: "parse failed" },
      },
      { type: "done", usage: { inputTokens: 1, outputTokens: 1 } },
    ]], requests));
    const controller = new AbortController();
    const model = withStructuredOutput({
      registry,
      modelId: "cheap:model",
      name: "Read",
      description: "Read a file",
      schema: z.object({ path: z.string() }).strict(),
    });

    const run = model.invoke({
      messages: [{ role: "user", content: "Repair" }],
      signal: controller.signal,
    });
    await vi.advanceTimersByTimeAsync(0);
    controller.abort(new Error("stop repair"));

    await expect(run).rejects.toThrow("stop repair");
    expect(requests).toHaveLength(1);
  });
});

function registryWith(adapter: ModelAdapter): ModelRegistry {
  return new ModelRegistry().register("cheap", adapter);
}

function fakeAdapter(streams: ModelEvent[][], requests: ModelRequest[]): ModelAdapter {
  let index = 0;
  return {
    async *stream(request) {
      requests.push(request);
      yield* streams[index++] ?? [];
    },
  };
}
