import { z } from "zod";
import { describe, expect, it, vi } from "vitest";

import { AgentLoop, type AgentLoopOptions } from "../../src/agent/loop.js";
import type { AgentEvent } from "../../src/agent/types.js";
import { ContextManager } from "../../src/context/manager.js";
import { HookBus } from "../../src/hooks/bus.js";
import { ModelRegistry } from "../../src/models/registry.js";
import type { ModelAdapter, ModelEvent, ModelRequest } from "../../src/models/types.js";
import { PermissionEngine } from "../../src/permissions/engine.js";
import { ToolRuntime } from "../../src/tools/runtime.js";

describe("AgentLoop", () => {
  it("switches models without replacing its context", async () => {
    const requests: ModelRequest[] = [];
    const fixture = createLoop({ adapter: fakeAdapter([
      [{ type: "done", usage: { inputTokens: 1, outputTokens: 1 } }],
      [{ type: "done", usage: { inputTokens: 1, outputTokens: 1 } }],
    ], requests) });
    await collect(fixture.loop.run({ prompt: "first" }));
    fixture.loop.setModel("fake:other");
    await collect(fixture.loop.run({ prompt: "second" }));
    expect(fixture.loop.modelId).toBe("fake:other");
    expect(requests[1]?.model).toBe("other");
    expect(requests[1]?.messages).toContainEqual({ role: "user", content: "first" });
  });

  it("adds transient skill context for one run without persisting it", async () => {
    const requests: ModelRequest[] = [];
    const fixture = createLoop({ adapter: fakeAdapter([
      [{ type: "done", usage: { inputTokens: 1, outputTokens: 1 } }],
      [{ type: "done", usage: { inputTokens: 1, outputTokens: 1 } }],
    ], requests) });
    await collect(fixture.loop.run({ prompt: "first", additionalContext: "Skill body" }));
    await collect(fixture.loop.run({ prompt: "second" }));
    expect(requests[0]?.messages).toContainEqual({ role: "system", content: "Skill body" });
    expect(requests[1]?.messages).not.toContainEqual({ role: "system", content: "Skill body" });
  });

  it("streams text, executes a tool once, feeds back its result, and records usage", async () => {
    const requests: ModelRequest[] = [];
    const streams: ModelEvent[][] = [
      [
        { type: "text", text: "Checking " },
        { type: "tool-call", id: "call-1", name: "echo", input: { value: "hi" } },
        { type: "done", usage: { inputTokens: 10, outputTokens: 2 } },
      ],
      [
        { type: "text", text: "finished" },
        { type: "done", usage: { inputTokens: 12, outputTokens: 3 } },
      ],
    ];
    let executions = 0;
    const fixture = createLoop({
      adapter: fakeAdapter(streams, requests),
      execute: async (input) => { executions += 1; return input; },
    });

    const events = await collect(fixture.loop.run({ prompt: "do it" }));

    expect(events.filter((event) => event.type === "text").map((event) => event.text)).toEqual(["Checking ", "finished"]);
    expect(events.filter((event) => event.type === "tool-start")).toHaveLength(1);
    expect(events.filter((event) => event.type === "tool-end")).toHaveLength(1);
    expect(events.filter((event) => event.type === "usage")).toEqual([
      { type: "usage", inputTokens: 10, outputTokens: 2, totalInputTokens: 10, totalOutputTokens: 2 },
      { type: "usage", inputTokens: 12, outputTokens: 3, totalInputTokens: 22, totalOutputTokens: 5 },
    ]);
    expect(events.at(-1)).toEqual({ type: "done", usage: { inputTokens: 22, outputTokens: 5 } });
    expect(executions).toBe(1);
    expect(requests[1]?.messages).toContainEqual(expect.objectContaining({
      role: "assistant",
      toolCalls: [{ id: "call-1", name: "echo", input: { value: "hi" } }],
    }));
    expect(requests[1]?.messages).toContainEqual(expect.objectContaining({ role: "tool", toolCallId: "call-1" }));
    expect(requests[1]?.messages.find((message) => message.role === "tool")?.content).toContain("\"value\":\"hi\"");
    expect(fixture.context.lastRecordedInputTokens).toBe(12);
  });

  it("reactively compacts and retries the same model iteration once after context overflow", async () => {
    const requests: ModelRequest[] = [];
    const fixture = createLoop({
      adapter: fakeAdapter([
        [{ type: "error", error: { code: "context_overflow", message: "prompt too long" } }],
        [
          { type: "text", text: "recovered" },
          { type: "done", usage: { inputTokens: 8, outputTokens: 2 } },
        ],
      ], requests),
      recentTurns: 0,
    });
    fixture.context.append({ role: "user", content: "older work" });
    fixture.context.append({ role: "assistant", content: "older result" });

    const events = await collect(fixture.loop.run({ prompt: "continue exactly once" }));

    expect(requests).toHaveLength(2);
    expect(requests.flatMap((request) => request.messages).filter((message) => message.content === "continue exactly once")).toHaveLength(1);
    expect(events.filter((event) => event.type === "compacted")).toHaveLength(1);
    expect(events.filter((event) => event.type === "text").map((event) => event.text)).toEqual(["recovered"]);
    expect(events.at(-1)?.type).toBe("done");
  });

  it("returns a second context overflow instead of retrying forever", async () => {
    const requests: ModelRequest[] = [];
    const fixture = createLoop({
      adapter: fakeAdapter([
        [{ type: "error", error: { code: "context_overflow", message: "first overflow" } }],
        [{ type: "error", error: { code: "context_overflow", message: "second overflow" } }],
      ], requests),
      recentTurns: 0,
    });

    const events = await collect(fixture.loop.run({ prompt: "long task" }));

    expect(requests).toHaveLength(2);
    expect(events.filter((event) => event.type === "compacted")).toHaveLength(1);
    expect(events.at(-1)).toEqual({ type: "error", error: { code: "context_overflow", message: "second overflow" } });
  });

  it("preserves the original context overflow when reactive compaction fails", async () => {
    const requests: ModelRequest[] = [];
    const fixture = createLoop({
      adapter: fakeAdapter([
        [{ type: "error", error: { code: "context_overflow", message: "original overflow" } }],
      ], requests),
      recentTurns: 0,
      summarize: async () => { throw new Error("summary backend failed"); },
    });
    fixture.context.append({ role: "user", content: "older work" });

    const events = await collect(fixture.loop.run({ prompt: "continue" }));

    expect(requests).toHaveLength(1);
    expect(events.at(-1)).toEqual({ type: "error", error: { code: "context_overflow", message: "original overflow" } });
  });

  it("does not retry context overflow after provider output is already visible", async () => {
    const requests: ModelRequest[] = [];
    const fixture = createLoop({
      adapter: fakeAdapter([
        [
          { type: "text", text: "partial answer" },
          { type: "error", error: { code: "context_overflow", message: "late overflow" } },
        ],
        [
          { type: "text", text: "duplicate answer" },
          { type: "done", usage: { inputTokens: 1, outputTokens: 1 } },
        ],
      ], requests),
      recentTurns: 0,
    });

    const events = await collect(fixture.loop.run({ prompt: "stream safely" }));

    expect(requests).toHaveLength(1);
    expect(events.filter((event) => event.type === "text").map((event) => event.text)).toEqual(["partial answer"]);
    expect(events.at(-1)).toEqual({ type: "error", error: { code: "context_overflow", message: "late overflow" } });
  });

  it("stops with a typed error at the iteration limit", async () => {
    const fixture = createLoop({
      adapter: fakeAdapter(Array.from({ length: 2 }, (_, index) => [
        { type: "tool-call", id: `call-${index}`, name: "echo", input: { value: "again" } },
        { type: "done", usage: { inputTokens: 1, outputTokens: 1 } },
      ])),
      maxIterations: 2,
    });

    const events = await collect(fixture.loop.run({ prompt: "loop" }));

    expect(events.at(-1)).toEqual(expect.objectContaining({ type: "error", error: { code: "iteration_limit", message: expect.any(String) } }));
  });

  it("turns an incomplete provider stream into a terminal typed error", async () => {
    vi.useFakeTimers();
    try {
      const requests: ModelRequest[] = [];
      const fixture = createLoop({ adapter: fakeAdapter([
        [{ type: "text", text: "partial" }], [], [],
      ], requests) });
      const eventsPromise = collect(fixture.loop.run({ prompt: "go" }));
      await vi.runAllTimersAsync();
      const events = await eventsPromise;
      expect(requests).toHaveLength(1);
      expect(events.filter((event) => event.type === "model-retry")).toHaveLength(0);
      expect(events.at(-1)).toEqual(expect.objectContaining({ type: "error", error: { code: "incomplete_stream", message: expect.any(String) } }));
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops consuming provider events after done", async () => {
    const fixture = createLoop({ adapter: fakeAdapter([[
      { type: "text", text: "complete" },
      { type: "done", usage: { inputTokens: 1, outputTokens: 1 } },
      { type: "text", text: "too late" },
    ]]) });
    const events = await collect(fixture.loop.run({ prompt: "go" }));
    expect(events.filter((event) => event.type === "text").map((event) => event.text)).toEqual(["complete"]);
  });

  it("records usage emitted before a provider error", async () => {
    const fixture = createLoop({ adapter: fakeAdapter([[
      { type: "usage", inputTokens: 4, outputTokens: 2 },
      { type: "error", error: { code: "context_overflow", message: "incomplete" } },
    ]]) });
    const events = await collect(fixture.loop.run({ prompt: "go" }));
    expect(events).toContainEqual({ type: "usage", inputTokens: 4, outputTokens: 2, totalInputTokens: 4, totalOutputTokens: 2 });
    expect(events.at(-1)).toEqual({ type: "error", error: { code: "context_overflow", message: "incomplete" } });
  });

  it("repairs invalid tool JSON with the cheap model without regenerating assistant text", async () => {
    const mainRequests: ModelRequest[] = [];
    const cheapRequests: ModelRequest[] = [];
    const executions: Array<{ value: string }> = [];
    const fixture = createLoop({
      adapter: fakeAdapter([
        [
          { type: "text", text: "Checking " },
          {
            type: "invalid-tool-call",
            id: "call-original",
            name: "echo",
            rawInput: String.raw`{"value":"C:\Users"}`,
            error: { code: "invalid_tool_arguments", message: "Bad escaped character at position 12" },
          },
          { type: "usage", inputTokens: 10, outputTokens: 2 },
          { type: "done", usage: { inputTokens: 10, outputTokens: 2 } },
        ],
        [
          { type: "text", text: "finished" },
          { type: "done", usage: { inputTokens: 12, outputTokens: 3 } },
        ],
      ], mainRequests),
      fallbackAdapter: fakeAdapter([[
        { type: "tool-call", id: "cheap-new-id", name: "echo", input: { value: "C:\\Users" } },
        { type: "usage", inputTokens: 2, outputTokens: 1 },
        { type: "done", usage: { inputTokens: 2, outputTokens: 1 } },
      ]], cheapRequests),
      fallbackModelId: "cheap:small",
      execute: async (input) => { executions.push(input); return input; },
    });
    const beforePayloads: Record<string, unknown>[] = [];
    const afterPayloads: Record<string, unknown>[] = [];
    fixture.hooks.on("BeforeModelCall", (event) => {
      beforePayloads.push(event.payload);
      return { decision: "allow" };
    });
    fixture.hooks.on("AfterModelCall", (event) => {
      afterPayloads.push(event.payload);
      return { decision: "allow" };
    });

    const events = await collect(fixture.loop.run({ prompt: "repair it" }));

    expect(mainRequests).toHaveLength(2);
    expect(cheapRequests).toHaveLength(1);
    expect(cheapRequests[0]?.messages.map(({ content }) => content).join("\n"))
      .toMatch(/Bad escaped character|C:\\Users/);
    expect(events.filter((event) => event.type === "text").map((event) => event.text))
      .toEqual(["Checking ", "finished"]);
    expect(executions).toEqual([{ value: "C:\\Users" }]);
    const repairedAssistant = mainRequests[1]?.messages.find((message) =>
      message.role === "assistant" && message.toolCalls?.length === 1,
    );
    expect(repairedAssistant).toMatchObject({
      content: "Checking ",
      toolCalls: [{ id: "call-original", name: "echo", input: { value: "C:\\Users" } }],
    });
    expect(events.filter((event) => event.type === "usage")).toContainEqual({
      type: "usage",
      inputTokens: 2,
      outputTokens: 1,
      totalInputTokens: 12,
      totalOutputTokens: 3,
    });
    expect(beforePayloads).toContainEqual(expect.objectContaining({
      modelId: "cheap:small",
      purpose: "structured-output-repair",
      tool: "echo",
      repairAttempt: 1,
      repairMaxAttempts: 4,
    }));
    expect(afterPayloads).toContainEqual(expect.objectContaining({
      modelId: "cheap:small",
      purpose: "structured-output-repair",
      tool: "echo",
      repairAttempt: 1,
      repairMaxAttempts: 4,
      completed: true,
    }));
    expect(JSON.stringify(afterPayloads)).not.toContain(String.raw`{"value":"C:\Users"}`);
    expect(events.at(-1)?.type).toBe("done");
  });

  it("repairs a parsed tool call that fails the Zod input schema", async () => {
    const cheapRequests: ModelRequest[] = [];
    const executions: Array<{ value: string }> = [];
    const fixture = createLoop({
      adapter: fakeAdapter([
        [
          { type: "tool-call", id: "call-schema", name: "echo", input: { value: 42 } },
          { type: "done", usage: { inputTokens: 1, outputTokens: 1 } },
        ],
        [{ type: "done", usage: { inputTokens: 1, outputTokens: 1 } }],
      ]),
      fallbackAdapter: fakeAdapter([[
        { type: "tool-call", id: "cheap-id", name: "echo", input: { value: "42" } },
        { type: "done", usage: { inputTokens: 1, outputTokens: 1 } },
      ]], cheapRequests),
      fallbackModelId: "cheap:small",
      execute: async (input) => { executions.push(input); return input; },
    });

    const events = await collect(fixture.loop.run({ prompt: "repair schema" }));

    expect(cheapRequests).toHaveLength(1);
    expect(cheapRequests[0]?.messages.map(({ content }) => content).join("\n")).toMatch(/value|string/i);
    expect(executions).toEqual([{ value: "42" }]);
    expect(events.at(-1)?.type).toBe("done");
  });

  it("includes provider error details in AfterModelCall hooks", async () => {
    const fixture = createLoop({ adapter: fakeAdapter([[
      { type: "error", error: { code: "output_limit", message: "tool input was truncated" } },
    ]]) });
    let payload: Record<string, unknown> | undefined;
    fixture.hooks.on("AfterModelCall", (event) => {
      payload = event.payload;
      return { decision: "allow" };
    });

    await collect(fixture.loop.run({ prompt: "write a large file" }));

    expect(payload).toMatchObject({
      modelId: "fake:model",
      agent: "main",
      providerError: true,
      errorCode: "output_limit",
      errorMessage: "tool input was truncated",
    });
  });

  it("retries three main attempts then two cheap attempts with exponential backoff", async () => {
    vi.useFakeTimers();
    try {
      const requests: ModelRequest[] = [];
      const fixture = createLoop({
        adapter: fakeAdapter([
          [{ type: "error", error: { code: "network", message: "main-1" } }],
          [{ type: "error", error: { code: "rate_limit", message: "main-2" } }],
          [{ type: "error", error: { code: "unknown", message: "main-3" } }],
        ], requests),
        fallbackAdapter: fakeAdapter([
          [{ type: "error", error: { code: "network", message: "cheap-1" } }],
          [{ type: "done", usage: { inputTokens: 2, outputTokens: 1 } }],
        ], requests),
        fallbackModelId: "cheap:small",
      });

      const eventsPromise = collect(fixture.loop.run({ prompt: "recover" }));
      await vi.runAllTimersAsync();
      const events = await eventsPromise;

      expect(requests.map(({ model }) => model)).toEqual(["model", "model", "model", "small", "small"]);
      expect(events.filter((event) => event.type === "model-retry")).toEqual([
        { type: "model-retry", attempt: 2, maxAttempts: 5, delayMs: 1_000 },
        { type: "model-retry", attempt: 3, maxAttempts: 5, delayMs: 2_000 },
        { type: "model-retry", attempt: 4, maxAttempts: 5, delayMs: 4_000 },
        { type: "model-retry", attempt: 5, maxAttempts: 5, delayMs: 8_000 },
      ]);
      expect(events.some((event) => event.type === "error")).toBe(false);
      expect(JSON.stringify(events)).not.toContain("main-1");
      expect(JSON.stringify(events)).not.toContain("cheap-1");
      expect(events.at(-1)?.type).toBe("done");
      expect(fixture.loop.modelId).toBe("fake:model");
    } finally {
      vi.useRealTimers();
    }
  });

  it("exposes only the fifth recoverable failure as a terminal error", async () => {
    vi.useFakeTimers();
    try {
      const fixture = createLoop({
        adapter: fakeAdapter(Array.from({ length: 3 }, (_, index) => [
          { type: "error" as const, error: { code: "network" as const, message: `main-${index + 1}` } },
        ])),
        fallbackAdapter: fakeAdapter(Array.from({ length: 2 }, (_, index) => [
          { type: "error" as const, error: { code: "network" as const, message: `cheap-${index + 1}` } },
        ])),
        fallbackModelId: "cheap:small",
      });

      const eventsPromise = collect(fixture.loop.run({ prompt: "fail completely" }));
      await vi.runAllTimersAsync();
      const events = await eventsPromise;

      expect(events.filter((event) => event.type === "error")).toEqual([
        { type: "error", error: { code: "network", message: "cheap-2" } },
      ]);
      expect(events.filter((event) => event.type === "model-retry")).toHaveLength(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries an incomplete stream that ended before producing output", async () => {
    vi.useFakeTimers();
    try {
      const requests: ModelRequest[] = [];
      const fixture = createLoop({
        adapter: fakeAdapter([[], [], []], requests),
        fallbackAdapter: fakeAdapter([
          [{ type: "done", usage: { inputTokens: 1, outputTokens: 1 } }],
        ], requests),
        fallbackModelId: "cheap:small",
      });

      const eventsPromise = collect(fixture.loop.run({ prompt: "recover incomplete stream" }));
      await vi.runAllTimersAsync();
      const events = await eventsPromise;

      expect(requests.map(({ model }) => model)).toEqual(["model", "model", "model", "small"]);
      expect(events.filter((event) => event.type === "model-retry")).toHaveLength(3);
      expect(events.some((event) => event.type === "error")).toBe(false);
      expect(events.at(-1)?.type).toBe("done");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not retry non-recoverable failures or failures after visible output", async () => {
    const authRequests: ModelRequest[] = [];
    const auth = createLoop({ adapter: fakeAdapter([[
      { type: "error", error: { code: "authentication", message: "bad key" } },
    ]], authRequests), fallbackAdapter: fakeAdapter([]), fallbackModelId: "cheap:small" });
    const authEvents = await collect(auth.loop.run({ prompt: "authenticate" }));

    const partialRequests: ModelRequest[] = [];
    const partial = createLoop({ adapter: fakeAdapter([[
      { type: "text", text: "partial" },
      { type: "error", error: { code: "network", message: "stream broke" } },
    ]], partialRequests), fallbackAdapter: fakeAdapter([]), fallbackModelId: "cheap:small" });
    const partialEvents = await collect(partial.loop.run({ prompt: "stream" }));

    expect(authRequests).toHaveLength(1);
    expect(authEvents.filter((event) => event.type === "model-retry")).toHaveLength(0);
    expect(authEvents.at(-1)).toEqual({ type: "error", error: { code: "authentication", message: "bad key" } });
    expect(partialRequests).toHaveLength(1);
    expect(partialEvents.filter((event) => event.type === "model-retry")).toHaveLength(0);
    expect(partialEvents.at(-1)).toEqual({ type: "error", error: { code: "network", message: "stream broke" } });
  });

  it("audits every physical model attempt with attempt metadata", async () => {
    vi.useFakeTimers();
    try {
      const fixture = createLoop({
        adapter: fakeAdapter([
          [{ type: "error", error: { code: "network", message: "temporary" } }],
          [{ type: "done", usage: { inputTokens: 1, outputTokens: 1 } }],
        ]),
        fallbackAdapter: fakeAdapter([]),
        fallbackModelId: "cheap:small",
      });
      const payloads: Record<string, unknown>[] = [];
      fixture.hooks.on("AfterModelCall", (event) => {
        payloads.push(event.payload);
        return { decision: "allow" };
      });

      const eventsPromise = collect(fixture.loop.run({ prompt: "audit retries" }));
      await vi.runAllTimersAsync();
      await eventsPromise;

      expect(payloads).toEqual([
        expect.objectContaining({ modelId: "fake:model", attempt: 1, maxAttempts: 5, providerError: true }),
        expect.objectContaining({ modelId: "fake:model", attempt: 2, maxAttempts: 5, providerError: false }),
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops during exponential backoff when the run is cancelled", async () => {
    vi.useFakeTimers();
    try {
      const requests: ModelRequest[] = [];
      const controller = new AbortController();
      const fixture = createLoop({
        adapter: fakeAdapter([
          [{ type: "error", error: { code: "network", message: "temporary" } }],
          [{ type: "done", usage: { inputTokens: 1, outputTokens: 1 } }],
        ], requests),
        fallbackAdapter: fakeAdapter([]),
        fallbackModelId: "cheap:small",
      });

      const eventsPromise = collect(fixture.loop.run({ prompt: "cancel retry", signal: controller.signal }));
      await vi.advanceTimersByTimeAsync(0);
      controller.abort(new Error("stop retrying"));
      await vi.runAllTimersAsync();
      const events = await eventsPromise;

      expect(requests).toHaveLength(1);
      expect(events.filter((event) => event.type === "model-retry")).toHaveLength(1);
      expect(events.at(-1)).toEqual({ type: "error", error: { code: "cancelled", message: "stop retrying" } });
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports cancellation that occurs while a tool is running", async () => {
    const controller = new AbortController();
    const fixture = createLoop({
      adapter: fakeAdapter([[
        { type: "tool-call", id: "call", name: "echo", input: { value: "wait" } },
        { type: "done", usage: { inputTokens: 1, outputTokens: 1 } },
      ]]),
      execute: async (_input, signal) => new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        queueMicrotask(() => controller.abort(new Error("stop now")));
      }),
    });

    const events = await collect(fixture.loop.run({ prompt: "go", signal: controller.signal }));

    expect(events.at(-1)).toEqual({ type: "error", error: { code: "cancelled", message: "stop now" } });
    expect(events).toContainEqual({
      type: "tool-end",
      id: "call",
      name: "echo",
      result: { ok: false, error: { code: "cancelled", message: "stop now" } },
    });
  });

  it("turns non-serializable tool output into a typed terminal error", async () => {
    const fixture = createLoop({
      adapter: fakeAdapter([[
        { type: "tool-call", id: "call", name: "echo", input: { value: "big" } },
        { type: "done", usage: { inputTokens: 1, outputTokens: 1 } },
      ]]),
      execute: async () => 1n,
    });

    const events = await collect(fixture.loop.run({ prompt: "go" }));

    expect(events.at(-1)).toEqual(expect.objectContaining({ type: "error", error: { code: "unknown", message: expect.stringContaining("BigInt") } }));
  });

  it("records a complete multi-tool turn atomically when cancellation interrupts execution", async () => {
    const controller = new AbortController();
    const requests: ModelRequest[] = [];
    const fixture = createLoop({
      adapter: fakeAdapter([[
        { type: "tool-call", id: "one", name: "echo", input: { value: "one" } },
        { type: "tool-call", id: "two", name: "echo", input: { value: "two" } },
        { type: "done", usage: { inputTokens: 1, outputTokens: 1 } },
      ], [
        { type: "text", text: "recovered" },
        { type: "done", usage: { inputTokens: 1, outputTokens: 1 } },
      ]], requests),
      execute: async (_input, signal) => new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        queueMicrotask(() => controller.abort(new Error("cancel tools")));
      }),
    });

    await collect(fixture.loop.run({ prompt: "first", signal: controller.signal }));
    const events = await collect(fixture.loop.run({ prompt: "second" }));

    expect(events.at(-1)?.type).toBe("done");
    const assistant = requests[1]?.messages.find((message) => message.toolCalls?.length === 2);
    expect(assistant?.toolCalls?.map((call) => call.id)).toEqual(["one", "two"]);
    expect(requests[1]?.messages.filter((message) => message.role === "tool").map((message) => message.toolCallId)).toEqual(["one", "two"]);
    expect(requests[1]?.messages.filter((message) => message.role === "tool").every((message) => message.content.includes("cancel"))).toBe(true);
  });

  it.each([
    ["BigInt", () => 1n],
    ["cyclic", () => { const value: Record<string, unknown> = {}; value.self = value; return value; }],
    ["toJSON", () => ({ toJSON() { throw new Error("bad toJSON"); } })],
  ])("stages typed results for every call when %s output cannot serialize", async (_name, output) => {
    const requests: ModelRequest[] = [];
    let executions = 0;
    const fixture = createLoop({
      adapter: fakeAdapter([[
        { type: "tool-call", id: "bad", name: "echo", input: { value: "bad" } },
        { type: "tool-call", id: "skipped", name: "echo", input: { value: "skip" } },
        { type: "done", usage: { inputTokens: 1, outputTokens: 1 } },
      ], [
        { type: "done", usage: { inputTokens: 1, outputTokens: 1 } },
      ]], requests),
      execute: async () => { executions += 1; return output(); },
    });

    await collect(fixture.loop.run({ prompt: "first" }));
    await collect(fixture.loop.run({ prompt: "second" }));

    expect(executions).toBe(1);
    const tools = requests[1]?.messages.filter((message) => message.role === "tool") ?? [];
    expect(tools.map((message) => message.toolCallId)).toEqual(["bad", "skipped"]);
    expect(tools.every((message) => message.content.includes("error"))).toBe(true);
  });

  it("surfaces the tool's hint on tool-start and tool-end", async () => {
    const fixture = createLoop({
      adapter: fakeAdapter([
        [
          { type: "tool-call", id: "call-1", name: "echo", input: { value: "hi" } },
          { type: "done", usage: { inputTokens: 1, outputTokens: 1 } },
        ],
        [{ type: "done", usage: { inputTokens: 1, outputTokens: 1 } }],
      ]),
      toolSummarize: (input) => `echo: ${input.value}`,
    });

    const events = await collect(fixture.loop.run({ prompt: "do it" }));

    const starts = events.filter((event): event is Extract<AgentEvent, { type: "tool-start" }> => event.type === "tool-start");
    const ends = events.filter((event): event is Extract<AgentEvent, { type: "tool-end" }> => event.type === "tool-end");
    expect(starts).toHaveLength(1);
    expect(starts[0]!.hint).toBe("echo: hi");
    expect(ends).toHaveLength(1);
    expect(ends[0]!.hint).toBe("echo: hi");
  });

  it("omits hint when the tool has no summarize", async () => {
    const fixture = createLoop({
      adapter: fakeAdapter([
        [
          { type: "tool-call", id: "call-1", name: "echo", input: { value: "hi" } },
          { type: "done", usage: { inputTokens: 1, outputTokens: 1 } },
        ],
        [{ type: "done", usage: { inputTokens: 1, outputTokens: 1 } }],
      ]),
    });

    const events = await collect(fixture.loop.run({ prompt: "do it" }));
    const starts = events.filter((event): event is Extract<AgentEvent, { type: "tool-start" }> => event.type === "tool-start");
    const ends = events.filter((event): event is Extract<AgentEvent, { type: "tool-end" }> => event.type === "tool-end");
    expect(starts[0]!.hint).toBeUndefined();
    expect(ends[0]!.hint).toBeUndefined();
  });
});

function createLoop(options: {
  adapter: ModelAdapter;
  fallbackAdapter?: ModelAdapter;
  fallbackModelId?: string;
  execute?: (input: { value: string }, signal: AbortSignal) => Promise<unknown>;
  maxIterations?: number;
  recentTurns?: number;
  summarize?: () => Promise<string>;
  toolSummarize?: (input: { value: string }) => string | undefined;
}) {
  const hooks = new HookBus();
  const tool = {
    name: "echo",
    description: "echo input",
    inputSchema: z.object({ value: z.string() }),
    paths: () => [],
    ...(options.toolSummarize === undefined ? {} : { summarize: options.toolSummarize }),
    execute: options.execute ?? (async (input: { value: string }) => input),
  };
  const runtime = new ToolRuntime({
    tools: [tool],
    hooks,
    permissions: new PermissionEngine({ workspace: process.cwd() }),
    approve: () => "once",
  });
  const registry = new ModelRegistry().register("fake", options.adapter);
  if (options.fallbackAdapter !== undefined) registry.register("cheap", options.fallbackAdapter);
  const context = new ContextManager({
    system: "system",
    compactAtChars: 100_000,
    toolOutputChars: 1_000,
    ...(options.recentTurns === undefined ? {} : { recentTurns: options.recentTurns }),
    summarize: options.summarize ?? (async () => "summary"),
    hooks,
  });
  const loopOptions: AgentLoopOptions = {
    registry,
    modelId: "fake:model",
    ...(options.fallbackModelId === undefined ? {} : { fallbackModelId: options.fallbackModelId }),
    context,
    runtime,
    hooks,
    tools: [{ name: tool.name, description: tool.description, inputSchema: { type: "object" } }],
    maxIterations: options.maxIterations ?? 4,
  };
  return { loop: new AgentLoop(loopOptions), runtime, context, hooks };
}

function fakeAdapter(streams: ModelEvent[][], requests: ModelRequest[] = []): ModelAdapter {
  let index = 0;
  return {
    async *stream(request) {
      requests.push(request);
      for (const event of streams[index++] ?? []) yield event;
    },
  };
}

async function collect(stream: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}
