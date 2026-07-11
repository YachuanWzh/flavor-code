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
    expect(requests[1]?.messages).toContainEqual(expect.objectContaining({ role: "tool", toolCallId: "call-1" }));
    expect(requests[1]?.messages.find((message) => message.role === "tool")?.content).toContain("\"value\":\"hi\"");
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
});

function createLoop(options: {
  adapter: ModelAdapter;
  execute?: (input: { value: string }) => Promise<unknown>;
  maxIterations?: number;
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
    approve: () => true,
  });
  const registry = new ModelRegistry().register("fake", options.adapter);
  const context = new ContextManager({
    system: "system",
    compactAtChars: 100_000,
    toolOutputChars: 1_000,
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
  return { loop: new AgentLoop(loopOptions), runtime };
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
