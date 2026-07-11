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
});
