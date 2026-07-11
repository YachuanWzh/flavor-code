import { z } from "zod";
import { describe, expect, it, vi } from "vitest";

import { ContextManager } from "../../src/context/manager.js";
import { HookBus } from "../../src/hooks/bus.js";
import { ModelRegistry } from "../../src/models/registry.js";
import type { ModelAdapter } from "../../src/models/types.js";
import { LocalHarness } from "../../src/harness/local.js";
import { SubagentResultSchema, SubagentScheduler } from "../../src/agent/subagents.js";
import { TaskGraphSchema } from "../../src/agent/planner.js";
import { ToolRuntime } from "../../src/tools/runtime.js";

const node = (id: string, dependencies: string[] = []) => ({
  id,
  description: `run ${id}`,
  dependencies,
  expectedOutputs: [`${id}.txt`],
  verification: [`verify ${id}`],
});

const result = (taskId: string, status: "completed" | "failed" | "blocked" = "completed") => ({
  taskId,
  status,
  summary: `${taskId} ${status}`,
  filesChanged: [`${taskId}.txt`],
  commandsRun: [{ command: "npm test", exitCode: 0, summary: "passed" }],
  verification: [{ name: "tests", passed: true, details: "green" }],
  artifacts: [],
  risks: [],
  suggestedNextSteps: [],
});

describe("SubagentResultSchema", () => {
  it("accepts the exact structured result and rejects prose or extra fields", () => {
    expect(SubagentResultSchema.parse(result("a"))).toEqual(result("a"));
    expect(() => SubagentResultSchema.parse("finished the task")).toThrow();
    expect(() => SubagentResultSchema.parse({ ...result("a"), transcript: "private" })).toThrow();
  });
});

describe("SubagentScheduler", () => {
  it("defaults to exactly three concurrent subagents and validates the configured range", async () => {
    let running = 0;
    let peak = 0;
    const scheduler = new SubagentScheduler({
      hooks: new HookBus(),
      execute: async (task) => {
        running += 1;
        peak = Math.max(peak, running);
        await new Promise((resolve) => setTimeout(resolve, 5));
        running -= 1;
        return result(task.id);
      },
    });

    await scheduler.run(TaskGraphSchema.parse({ nodes: ["a", "b", "c", "d", "e"].map((id) => node(id)) }));

    expect(peak).toBe(3);
    expect(() => new SubagentScheduler({ maxSubagents: 0, hooks: new HookBus(), execute: async () => null })).toThrow();
    expect(() => new SubagentScheduler({ maxSubagents: 17, hooks: new HookBus(), execute: async () => null })).toThrow();
  });

  it("caps concurrency and starts nodes only after dependencies complete", async () => {
    const graph = TaskGraphSchema.parse({ nodes: [node("a"), node("b"), node("c", ["a"]), node("d", ["b"])] });
    let running = 0;
    let peak = 0;
    const started: string[] = [];
    const finished = new Set<string>();
    const scheduler = new SubagentScheduler({
      maxSubagents: 2,
      hooks: new HookBus(),
      execute: async (task) => {
        expect(task.dependencies.every((dependency) => finished.has(dependency))).toBe(true);
        started.push(task.id);
        running += 1;
        peak = Math.max(peak, running);
        await new Promise((resolve) => setTimeout(resolve, task.id === "a" ? 15 : 5));
        running -= 1;
        finished.add(task.id);
        return result(task.id);
      },
    });

    const outcome = await scheduler.run(graph);

    expect(peak).toBe(2);
    expect(started.slice(0, 2)).toEqual(["a", "b"]);
    expect(outcome.states).toEqual({ a: "completed", b: "completed", c: "completed", d: "completed" });
    expect(Object.keys(outcome.results)).toEqual(["a", "b", "c", "d"]);
  });

  it("blocks only failure descendants and preserves unrelated results", async () => {
    const graph = TaskGraphSchema.parse({ nodes: [
      node("root"), node("child", ["root"]), node("grandchild", ["child"]), node("sibling"),
    ] });
    const scheduler = new SubagentScheduler({
      maxSubagents: 2,
      hooks: new HookBus(),
      execute: async (task) => task.id === "root" ? result(task.id, "failed") : result(task.id),
    });

    const outcome = await scheduler.run(graph);

    expect(outcome.states).toEqual({ root: "failed", child: "blocked", grandchild: "blocked", sibling: "completed" });
    expect(outcome.results.sibling).toEqual(result("sibling"));
    expect(outcome.results.child?.status).toBe("blocked");
  });

  it("retries one invalid structured result and passes only parsed data onward", async () => {
    const graph = TaskGraphSchema.parse({ nodes: [node("a")] });
    const delivered: unknown[] = [];
    let attempts = 0;
    const scheduler = new SubagentScheduler({
      maxSubagents: 1,
      hooks: new HookBus(),
      execute: async (_task, execution) => {
        attempts += 1;
        expect(execution.attempt).toBe(attempts);
        return attempts === 1 ? "done" : result("a");
      },
      onResult: (parsed) => { delivered.push(parsed); },
    });

    const outcome = await scheduler.run(graph);

    expect(attempts).toBe(2);
    expect(outcome.states.a).toBe("completed");
    expect(delivered).toEqual([result("a")]);
  });

  it("fails after a second invalid result without leaking it", async () => {
    const graph = TaskGraphSchema.parse({ nodes: [node("a")] });
    const delivered: unknown[] = [];
    let attempts = 0;
    const scheduler = new SubagentScheduler({
      maxSubagents: 1,
      hooks: new HookBus(),
      execute: async () => { attempts += 1; return "still prose"; },
      onResult: (parsed) => { delivered.push(parsed); },
    });

    const outcome = await scheduler.run(graph);

    expect(attempts).toBe(2);
    expect(outcome.states.a).toBe("failed");
    expect(SubagentResultSchema.safeParse(outcome.results.a).success).toBe(true);
    expect(delivered).toEqual([outcome.results.a]);
  });

  it("aborts promptly and balances subagent hooks even if execution ignores cancellation", async () => {
    const hooks = new HookBus();
    const events: string[] = [];
    hooks.on("SubagentStart", (event) => { events.push(`${event.type}:${String(event.payload.taskId)}`); return { decision: "allow" }; });
    hooks.on("SubagentStop", (event) => { events.push(`${event.type}:${String(event.payload.taskId)}`); return { decision: "allow" }; });
    const scheduler = new SubagentScheduler({
      maxSubagents: 1,
      hooks,
      execute: async () => new Promise(() => undefined),
    });
    const controller = new AbortController();
    const run = scheduler.run(TaskGraphSchema.parse({ nodes: [node("a")] }), controller.signal);
    queueMicrotask(() => controller.abort(new Error("cancelled by test")));

    await expect(run).rejects.toThrow("cancelled by test");
    expect(events).toEqual(["SubagentStart:a", "SubagentStop:a"]);
  });

  it("drains every started child through delayed stop hooks before rejecting cancellation", async () => {
    const hooks = new HookBus();
    const events: string[] = [];
    const unhandled: unknown[] = [];
    const onUnhandled = (error: unknown) => { unhandled.push(error); };
    process.on("unhandledRejection", onUnhandled);
    let started = 0;
    let releaseStarts!: () => void;
    const allStarted = new Promise<void>((resolve) => { releaseStarts = resolve; });
    hooks.on("SubagentStart", (event) => {
      events.push(`start:${String(event.payload.taskId)}`);
      started += 1;
      if (started === 3) releaseStarts();
      return { decision: "allow" };
    });
    hooks.on("SubagentStop", async (event) => {
      await new Promise((resolve) => setTimeout(resolve, 15));
      events.push(`stop:${String(event.payload.taskId)}`);
      return { decision: "allow" };
    });
    const scheduler = new SubagentScheduler({
      hooks,
      execute: async () => new Promise(() => undefined),
    });
    const controller = new AbortController();
    try {
      const run = scheduler.run(TaskGraphSchema.parse({ nodes: [node("a"), node("b"), node("c")] }), controller.signal);
      await allStarted;
      controller.abort(new Error("cancel all"));

      await expect(run).rejects.toThrow("cancel all");
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(events.filter((event) => event.startsWith("start:"))).toHaveLength(3);
      expect(events.filter((event) => event.startsWith("stop:"))).toHaveLength(3);
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("turns a stop-hook error into a node failure while unrelated work continues", async () => {
    const hooks = new HookBus();
    hooks.on("SubagentStop", (event) => {
      if (event.payload.taskId === "a") throw new Error("stop hook broke");
      return { decision: "allow" };
    });
    const scheduler = new SubagentScheduler({
      maxSubagents: 2,
      hooks,
      execute: async (task) => result(task.id),
    });

    const outcome = await scheduler.run(TaskGraphSchema.parse({ nodes: [node("a"), node("b")] }));

    expect(outcome.states).toEqual({ a: "failed", b: "completed" });
    expect(outcome.results.a?.summary).toContain("stop hook broke");
  });
});

describe("LocalHarness", () => {
  it("switches role models and only changes main permissions", () => {
    const harness = harnessFixture(() => contextFixture());
    harness.setModel("main", "fake:new-main");
    harness.setModel("subagent", "fake:new-child");
    harness.setPermissionMode("full");
    expect(harness.mainModelId).toBe("fake:new-main");
    expect(harness.subagentModelId).toBe("fake:new-child");
    expect(harness.permissionMode).toBe("full");
    expect(harness.createSubagent(node("fresh")).modelId).toBe("fake:new-child");
  });

  it("creates isolated cheaper subagents without Task and with workspace permissions", async () => {
    const hooks = new HookBus();
    const adapter: ModelAdapter = { async *stream() { yield { type: "done", usage: { inputTokens: 0, outputTokens: 0 } }; } };
    const registry = new ModelRegistry().register("fake", adapter);
    const tools = ["Read", "Task"].map((name) => ({
      name,
      description: name,
      inputSchema: z.object({ path: z.string() }),
      paths: (input: { path: string }) => [input.path],
      execute: async () => null,
    }));
    const harness = new LocalHarness({
      registry,
      hooks,
      workspace: process.cwd(),
      mainModelId: "fake:expensive",
      subagentModelId: "fake:cheap",
      tools,
      approve: () => true,
      createContext: () => new ContextManager({
        system: "system",
        compactAtChars: 10_000,
        toolOutputChars: 1_000,
        summarize: async () => "summary",
        hooks,
      }),
    });

    const first = harness.createSubagent(node("one"));
    const second = harness.createSubagent(node("two"));

    expect(harness.main.modelId).toBe("fake:expensive");
    expect(first.modelId).toBe("fake:cheap");
    expect(first.tools.map((tool) => tool.name)).toEqual(["Read"]);
    expect(first.tools[0]?.inputSchema).toEqual(expect.objectContaining({
      type: "object",
      properties: expect.objectContaining({ path: expect.objectContaining({ type: "string" }) }),
      required: ["path"],
    }));
    expect(first.context).not.toBe(second.context);
    expect(await first.runtime.execute({ name: "Task", input: { path: "." } }, { agent: "subagent" })).toEqual(
      expect.objectContaining({ ok: false, error: expect.objectContaining({ code: "unknown_tool" }) }),
    );
    expect(await first.runtime.execute({ name: "Read", input: { path: ".." } }, { agent: "subagent" })).toEqual(
      expect.objectContaining({ ok: false, error: expect.objectContaining({ code: "permission_denied" }) }),
    );
  });

  it("rejects context factories that reuse the main or a previous child context", () => {
    const main = contextFixture();
    const reusedChild = contextFixture();
    const mainReuse = harnessFixture(() => main);
    expect(() => mainReuse.createSubagent(node("main-reuse"))).toThrow("fresh ContextManager");

    const contexts = [contextFixture(), reusedChild, reusedChild];
    const childReuse = harnessFixture(() => contexts.shift()!);
    childReuse.createSubagent(node("first"));
    expect(() => childReuse.createSubagent(node("second"))).toThrow("fresh ContextManager");
  });

  it("disposes child runtimes idempotently and automatically on success or failure", async () => {
    const harness = harnessFixture(() => contextFixture());
    const child = harness.createSubagent(node("manual"));
    const manualDispose = vi.spyOn(child.runtime, "dispose");

    child.dispose();
    child.dispose();
    await child[Symbol.asyncDispose]();
    expect(manualDispose).toHaveBeenCalledTimes(1);

    let automaticDispose: ReturnType<typeof vi.spyOn> | undefined;
    await expect(harness.runSubagent(node("automatic"), async (running) => {
      automaticDispose = vi.spyOn(running.runtime, "dispose");
      throw new Error("child failed");
    })).rejects.toThrow("child failed");
    expect(automaticDispose).toHaveBeenCalledTimes(1);

    let successDispose: ReturnType<typeof vi.spyOn> | undefined;
    await expect(harness.runSubagent(node("success"), async (running) => {
      successDispose = vi.spyOn(running.runtime, "dispose");
      return "ok";
    })).resolves.toBe("ok");
    expect(successDispose).toHaveBeenCalledTimes(1);

    const cancellationDispose = vi.spyOn(ToolRuntime.prototype, "dispose");
    const controller = new AbortController();
    controller.abort(new Error("cancel child"));
    await expect(harness.runSubagent(node("cancel"), async () => undefined, controller.signal)).rejects.toThrow("cancel child");
    expect(cancellationDispose).toHaveBeenCalledTimes(1);
    cancellationDispose.mockRestore();
  });

  it("runs child loops with the cheap model, subagent identity, no Task tool, and no approval callback", async () => {
    const requests: Array<{ model: string; tools: string[]; messages: string[] }> = [];
    let cheapCalls = 0;
    const adapter: ModelAdapter = {
      async *stream(request) {
        requests.push({ model: request.model, tools: request.tools.map((tool) => tool.name), messages: request.messages.map((message) => message.content) });
        if (request.model === "cheap" && cheapCalls++ === 0) {
          yield { type: "tool-call", id: "network", name: "Network", input: {} };
        }
        yield { type: "done", usage: { inputTokens: 0, outputTokens: 0 } };
      },
    };
    let approvals = 0;
    const hooks = new HookBus();
    const harness = new LocalHarness({
      registry: new ModelRegistry().register("fake", adapter),
      hooks,
      workspace: process.cwd(),
      mainModelId: "fake:expensive",
      subagentModelId: "fake:cheap",
      tools: [
        { name: "Task", description: "delegate", inputSchema: z.object({}), paths: () => [], execute: async () => null },
        { name: "Network", description: "network", inputSchema: z.object({}), paths: () => [], execute: async () => null },
      ],
      approve: () => { approvals += 1; return true; },
      createContext: () => new ContextManager({
        system: "system", compactAtChars: 10_000, toolOutputChars: 1_000, summarize: async () => "summary", hooks,
      }),
    });

    await harness.runSubagent(node("identity"), async (child) => {
      for await (const _event of child.loop.run({ prompt: "run" })) { /* consume */ }
    });

    expect(requests.map((request) => request.model)).toEqual(["cheap", "cheap"]);
    expect(requests.every((request) => !request.tools.includes("Task"))).toBe(true);
    expect(requests[1]?.messages.join("\n")).toContain("approval_required");
    expect(approvals).toBe(0);
  });
});

function contextFixture(hooks = new HookBus()): ContextManager {
  return new ContextManager({
    system: "system",
    compactAtChars: 10_000,
    toolOutputChars: 1_000,
    summarize: async () => "summary",
    hooks,
  });
}

function harnessFixture(createContext: () => ContextManager): LocalHarness {
  const hooks = new HookBus();
  const adapter: ModelAdapter = { async *stream() { yield { type: "done", usage: { inputTokens: 0, outputTokens: 0 } }; } };
  return new LocalHarness({
    registry: new ModelRegistry().register("fake", adapter),
    hooks,
    workspace: process.cwd(),
    mainModelId: "fake:main",
    subagentModelId: "fake:child",
    tools: [],
    createContext,
  });
}
