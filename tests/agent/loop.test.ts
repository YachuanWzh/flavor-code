import { z } from "zod";
import { describe, expect, it } from "vitest";

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
    const fixture = createLoop({ adapter: fakeAdapter([[{ type: "text", text: "partial" }]]) });
    const events = await collect(fixture.loop.run({ prompt: "go" }));
    expect(events.at(-1)).toEqual(expect.objectContaining({ type: "error", error: { code: "incomplete_stream", message: expect.any(String) } }));
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
});

function createLoop(options: {
  adapter: ModelAdapter;
  execute?: (input: { value: string }, signal: AbortSignal) => Promise<unknown>;
  maxIterations?: number;
  recentTurns?: number;
}) {
  const hooks = new HookBus();
  const tool = {
    name: "echo",
    description: "echo input",
    inputSchema: z.object({ value: z.string() }),
    paths: () => [],
    execute: options.execute ?? (async (input: { value: string }) => input),
  };
  const runtime = new ToolRuntime({
    tools: [tool],
    hooks,
    permissions: new PermissionEngine({ workspace: process.cwd() }),
    approve: () => "once",
  });
  const registry = new ModelRegistry().register("fake", options.adapter);
  const context = new ContextManager({
    system: "system",
    compactAtChars: 100_000,
    toolOutputChars: 1_000,
    ...(options.recentTurns === undefined ? {} : { recentTurns: options.recentTurns }),
    summarize: async () => "summary",
    hooks,
  });
  const loopOptions: AgentLoopOptions = {
    registry,
    modelId: "fake:model",
    context,
    runtime,
    hooks,
    tools: [{ name: tool.name, description: tool.description, inputSchema: { type: "object" } }],
    maxIterations: options.maxIterations ?? 4,
  };
  return { loop: new AgentLoop(loopOptions), runtime, context };
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
