import { describe, expect, it } from "vitest";

import { createTaskPlanTools } from "../../src/agent/task-tools.js";
import type { TaskPlan } from "../../src/agent/task-plan.js";

describe("createTaskPlanTools", () => {
  it("creates and updates plans through main planning tools", async () => {
    let plan: TaskPlan | undefined;
    const published: TaskPlan[] = [];
    const operations: string[] = [];
    const [planTool, updateTool] = createTaskPlanTools({
      getPlan: () => plan,
      commit: async (next, operation) => {
        plan = next;
        published.push(next);
        operations.push(operation);
      },
    });
    const signal = new AbortController().signal;

    await planTool.execute({ tasks: [{
      id: "inspect",
      subject: "Inspect code",
      activeForm: "Inspecting code",
      status: "in_progress",
      dependencies: [],
    }] }, signal);
    await updateTool.execute({ taskId: "inspect", status: "completed", result: "done" }, signal);

    expect(planTool.name).toBe("TaskPlan");
    expect(updateTool.name).toBe("TaskUpdate");
    expect(operations).toEqual(["replace", "update"]);
    expect(published.at(-1)?.tasks[0]).toMatchObject({ status: "completed", result: "done" });
  });

  it("leaves the current plan unchanged when an update is invalid", async () => {
    let plan: TaskPlan | undefined;
    const [planTool, updateTool] = createTaskPlanTools({
      getPlan: () => plan,
      commit: async (next) => { plan = next; },
    });
    const signal = new AbortController().signal;
    await planTool.execute({ tasks: [{
      id: "inspect",
      subject: "Inspect code",
      activeForm: "Inspecting code",
      status: "pending",
      dependencies: [],
    }] }, signal);

    await expect(updateTool.execute({ taskId: "missing", status: "in_progress" }, signal)).rejects.toThrow(/unknown task/i);
    expect(plan?.tasks[0]?.status).toBe("pending");
  });

  it("requires an existing plan before updating", async () => {
    const [, updateTool] = createTaskPlanTools({ getPlan: () => undefined, commit: async () => {} });
    await expect(updateTool.execute({ taskId: "inspect", status: "in_progress" }, new AbortController().signal))
      .rejects.toThrow(/no task plan/i);
  });
});
