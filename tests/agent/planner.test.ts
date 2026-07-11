import { z } from "zod";
import { describe, expect, it } from "vitest";

import { HookBus } from "../../src/hooks/bus.js";
import { TaskGraphSchema, TaskPlanner } from "../../src/agent/planner.js";

const node = (id: string, dependencies: string[] = []) => ({
  id,
  description: `run ${id}`,
  dependencies,
  expectedOutputs: [`${id}.txt`],
  verification: [`verify ${id}`],
});

describe("TaskGraphSchema", () => {
  it.each([
    ["duplicate ids", { nodes: [node("a"), node("a")] }],
    ["missing dependencies", { nodes: [node("a", ["missing"])] }],
    ["cycles", { nodes: [node("a", ["b"]), node("b", ["a"])] }],
  ])("rejects %s", (_name, graph) => {
    expect(() => TaskGraphSchema.parse(graph)).toThrow();
  });
});

describe("TaskPlanner", () => {
  it("emits balanced planning hooks when validation fails", async () => {
    const hooks = new HookBus();
    const events: string[] = [];
    hooks.on("BeforePlan", (event) => { events.push(event.type); return { decision: "allow" }; });
    hooks.on("AfterPlan", (event) => { events.push(event.type); return { decision: "allow" }; });

    await expect(new TaskPlanner({ hooks }).plan({ nodes: [node("a", ["nope"])] })).rejects.toThrow();
    expect(events).toEqual(["BeforePlan", "AfterPlan"]);
  });

  it("preserves the primary validation error when AfterPlan also fails", async () => {
    const hooks = new HookBus();
    hooks.on("AfterPlan", () => { throw new Error("after hook failed"); });

    const error = await new TaskPlanner({ hooks }).plan({ nodes: [node("a", ["missing"])] }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(z.ZodError);
    expect((error as { afterPlanError?: unknown }).afterPlanError).toEqual(expect.objectContaining({ message: "after hook failed" }));
    expect((error as Error).cause).toEqual(expect.objectContaining({ message: "after hook failed" }));
  });

  it("preserves the primary error when secondary metadata cannot be attached", async () => {
    const hooks = new HookBus();
    const primary = new Error("primary failure");
    Object.defineProperty(primary, "afterPlanError", { value: "reserved", configurable: false });
    hooks.on("BeforePlan", () => { throw primary; });
    hooks.on("AfterPlan", () => { throw new Error("after hook failed"); });

    const error = await new TaskPlanner({ hooks }).plan({ nodes: [] }).catch((caught: unknown) => caught);

    expect(error).toBe(primary);
  });
});
