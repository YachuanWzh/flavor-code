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
