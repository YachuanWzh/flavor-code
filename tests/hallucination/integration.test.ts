import { z } from "zod";
import { describe, expect, it, vi } from "vitest";

import { AgentLoop } from "../../src/agent/loop.js";
import type { AgentEvent } from "../../src/agent/types.js";
import { ContextManager } from "../../src/context/manager.js";
import { HallucinationGuard } from "../../src/hallucination/guard.js";
import { HookBus } from "../../src/hooks/bus.js";
import { ModelRegistry } from "../../src/models/registry.js";
import type { ModelAdapter, ModelEvent, ModelRequest } from "../../src/models/types.js";
import { PermissionEngine } from "../../src/permissions/engine.js";
import { ToolRuntime } from "../../src/tools/runtime.js";

describe("AgentLoop + HallucinationGuard integration", () => {
  it("calls guard.recordToolCall, guard.recordToolResult, and guard.evaluate during a complete run", async () => {
    vi.useFakeTimers();
    try {
      const registry = new ModelRegistry();

      // Register both main and cheap adapters
      const mainRequests: ModelRequest[] = [];
      const cheapRequests: ModelRequest[] = [];
      registry.register("fake", fakeAdapter([
        [
          { type: "text", text: "I will read a file." },
          { type: "tool-call", id: "call-1", name: "echo", input: { value: "hello" } },
          { type: "done", usage: { inputTokens: 10, outputTokens: 2 } },
        ],
        [
          { type: "text", text: "Done reading." },
          { type: "done", usage: { inputTokens: 12, outputTokens: 2 } },
        ],
      ], mainRequests));
      registry.register("cheap", fakeAdapter([[
        { type: "tool-call", id: "c1", name: "flavor_confidence", input: {
          taskAlignment: 0.95, evidenceGrounding: 0.95, processReliability: 0.95,
          reason: "Output matches the query", unsupportedClaims: [],
        } },
        { type: "done", usage: { inputTokens: 5, outputTokens: 2 } },
      ]], cheapRequests));

      // Create HallucinationGuard
      const guard = new HallucinationGuard({ registry, cheapModelId: "cheap:mini" });

      // Spy all guard methods
      const recordToolCallSpy = vi.spyOn(guard, "recordToolCall");
      const recordToolResultSpy = vi.spyOn(guard, "recordToolResult");
      const evaluateSpy = vi.spyOn(guard, "evaluate");

      // Create AgentLoop with guard
      const hooks = new HookBus();
      const tool = {
        name: "echo",
        description: "echo input",
        inputSchema: z.object({ value: z.string() }),
        paths: () => [],
        execute: async (input: { value: string }) => input,
      };
      const runtime = new ToolRuntime({
        tools: [tool],
        hooks,
        permissions: new PermissionEngine({ workspace: process.cwd() }),
        approve: () => "once",
      });
      const context = new ContextManager({
        system: "system",
        compactAtChars: 100_000,
        toolOutputChars: 1_000,
        summarize: async () => "summary",
        hooks,
      });
      const loop = new AgentLoop({
        registry,
        modelId: "fake:model",
        context,
        runtime,
        hooks,
        tools: [{ name: tool.name, description: tool.description, inputSchema: { type: "object" } }],
        maxIterations: 4,
        agent: "main",
        hallucinationGuard: guard,
      });

      // Run
      const promise = collect(loop.run({ prompt: "Read a file" }));
      await vi.runAllTimersAsync();
      const events = await promise;

      // Assertions: guard methods were called
      // 1. recordToolCall should be called for the tool call
      expect(recordToolCallSpy).toHaveBeenCalledWith("echo", { value: "hello" }, "call-1");
      expect(recordToolCallSpy).toHaveBeenCalledTimes(1);

      // 2. recordToolResult should be called when the tool result comes back
      expect(recordToolResultSpy).toHaveBeenCalledWith(
        "echo",
        expect.objectContaining({ ok: true, output: { value: "hello" } }),
        "call-1",
      );
      expect(recordToolResultSpy).toHaveBeenCalledTimes(1);

      // 3. evaluate should be called once, when the model returns no tool calls (done)
      expect(evaluateSpy).toHaveBeenCalledTimes(1);
      expect(evaluateSpy).toHaveBeenCalledWith("Read a file", expect.stringContaining("Done reading"));

      // 4. The run should complete normally (no warning)
      const doneEvent = events.find((e) => e.type === "done");
      expect(doneEvent).toBeDefined();

      // 5. Confidence check should have used the cheap model
      expect(cheapRequests).toHaveLength(1);

      // Verify spies weren't tampered with
      recordToolCallSpy.mockRestore();
      recordToolResultSpy.mockRestore();
      evaluateSpy.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });

  it("emits a warning event when the guard fails", async () => {
    vi.useFakeTimers();
    try {
      const registry = new ModelRegistry();

      // Cheap model returns low confidence
      registry.register("fake", fakeAdapter([[
        { type: "text", text: "I think it works. Maybe." },
        { type: "done", usage: { inputTokens: 5, outputTokens: 2 } },
      ]]));
      registry.register("cheap", fakeAdapter([[
        { type: "tool-call", id: "c1", name: "flavor_confidence", input: {
          taskAlignment: 0.2, evidenceGrounding: 0.2, processReliability: 0.2,
          reason: "Output is vague and uncertain", unsupportedClaims: ["No verification evidence"],
        } },
        { type: "done", usage: { inputTokens: 5, outputTokens: 2 } },
      ]]));

      const guard = new HallucinationGuard({ registry, cheapModelId: "cheap:mini" });
      const hooks = new HookBus();
      const echo = {
        name: "echo",
        description: "echo input",
        inputSchema: z.object({ value: z.string() }),
        paths: () => [],
        execute: async (input: { value: string }) => input,
      };
      const runtime = new ToolRuntime({
        tools: [echo],
        hooks,
        permissions: new PermissionEngine({ workspace: process.cwd() }),
        approve: () => "once",
      });
      const context = new ContextManager({
        system: "system",
        compactAtChars: 100_000,
        toolOutputChars: 1_000,
        summarize: async () => "summary",
        hooks,
      });
      const loop = new AgentLoop({
        registry,
        modelId: "fake:model",
        context,
        runtime,
        hooks,
        tools: [{ name: echo.name, description: echo.description, inputSchema: { type: "object" } }],
        maxIterations: 4,
        agent: "main",
        hallucinationGuard: guard,
      });

      const promise = collect(loop.run({ prompt: "fix the critical production bug" }));
      await vi.runAllTimersAsync();
      const events = await promise;

      // Should have a warning about low confidence
      const warnings = events.filter((e) => e.type === "warning");
      expect(warnings).toHaveLength(1);
      expect(warnings[0]!.message).toContain("幻觉检测");
      expect(warnings[0]!.message).toMatch(/0\.20/);
      expect(warnings[0]!.message).toContain("vague");

      // Should still finish with done (warning is advisory, not terminal)
      expect(events.at(-1)?.type).toBe("done");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does NOT call evaluate for sub-agents (agent is not main)", async () => {
    const registry = new ModelRegistry();
    registry.register("fake", fakeAdapter([[
      { type: "done", usage: { inputTokens: 1, outputTokens: 1 } },
    ]]));

    const guard = new HallucinationGuard({ registry, cheapModelId: "cheap:missing" });
    const evaluateSpy = vi.spyOn(guard, "evaluate");

    const hooks = new HookBus();
    const context = new ContextManager({
      system: "system",
      compactAtChars: 100_000,
      toolOutputChars: 1_000,
      summarize: async () => "summary",
      hooks,
    });
    const echo = {
      name: "echo",
      description: "echo",
      inputSchema: z.object({ value: z.string() }),
      paths: () => [],
      execute: async (input: { value: string }) => input,
    };
    const runtime = new ToolRuntime({
      tools: [echo],
      hooks,
      permissions: new PermissionEngine({ workspace: process.cwd() }),
      approve: () => "once",
    });
    const loop = new AgentLoop({
      registry,
      modelId: "fake:model",
      context,
      runtime,
      hooks,
      tools: [{ name: echo.name, description: echo.description, inputSchema: { type: "object" } }],
      maxIterations: 4,
      agent: "subagent",
      hallucinationGuard: guard,
    });

    await collect(loop.run({ prompt: "do subagent work" }));

    // Sub-agents should NOT trigger evaluate
    expect(evaluateSpy).not.toHaveBeenCalled();

    evaluateSpy.mockRestore();
  });
});

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
