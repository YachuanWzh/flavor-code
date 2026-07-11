import { z } from "zod";
import { describe, expect, it } from "vitest";

import { ContextManager } from "../../src/context/manager.js";
import { HookBus } from "../../src/hooks/bus.js";
import { ModelRegistry } from "../../src/models/registry.js";
import type { ModelAdapter } from "../../src/models/types.js";
import { LocalHarness } from "../../src/harness/local.js";
import { SubagentResultSchema, SubagentScheduler } from "../../src/agent/subagents.js";
import { TaskGraphSchema } from "../../src/agent/planner.js";

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
    const graph = TaskGraphSchema.parse({ nodes: [node("root"), node("child", ["root"]), node("sibling")] });
    const scheduler = new SubagentScheduler({
      maxSubagents: 2,
      hooks: new HookBus(),
      execute: async (task) => task.id === "root" ? result(task.id, "failed") : result(task.id),
    });

    const outcome = await scheduler.run(graph);

    expect(outcome.states).toEqual({ root: "failed", child: "blocked", sibling: "completed" });
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
});
