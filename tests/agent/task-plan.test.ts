import { describe, expect, it } from "vitest";

import {
  TaskPlanSchema,
  normalizeAbandonedPlan,
  updatePlanTask,
  type PlanTaskStatus,
} from "../../src/agent/task-plan.js";

const task = (id: string, status: PlanTaskStatus = "pending", dependencies: string[] = []) => ({
  id,
  subject: `Do ${id}`,
  activeForm: `Doing ${id}`,
  status,
  dependencies,
});

describe("TaskPlanSchema", () => {
  it("accepts a valid dependency-ordered plan", () => {
    expect(TaskPlanSchema.parse({ tasks: [task("a"), task("b", "pending", ["a"])] }).tasks).toHaveLength(2);
  });

  it("rejects duplicate ids, unknown dependencies, duplicate dependencies, and cycles", () => {
    expect(() => TaskPlanSchema.parse({ tasks: [task("a"), task("a")] })).toThrow(/duplicate/i);
    expect(() => TaskPlanSchema.parse({ tasks: [task("a", "pending", ["missing"])] })).toThrow(/unknown/i);
    expect(() => TaskPlanSchema.parse({ tasks: [task("a"), task("b", "pending", ["a", "a"])] })).toThrow(/duplicate/i);
    expect(() => TaskPlanSchema.parse({ tasks: [task("a", "pending", ["b"]), task("b", "pending", ["a"])] })).toThrow(/cycle/i);
  });

  it("rejects more than one in-progress task", () => {
    expect(() => TaskPlanSchema.parse({ tasks: [task("a", "in_progress"), task("b", "in_progress")] })).toThrow(/one task/i);
  });
});

describe("updatePlanTask", () => {
  it("updates one task without mutating the previous plan", () => {
    const plan = TaskPlanSchema.parse({ tasks: [task("a"), task("b", "pending", ["a"])] });
    const next = updatePlanTask(plan, { taskId: "a", status: "in_progress" });

    expect(next.tasks[0]?.status).toBe("in_progress");
    expect(plan.tasks[0]?.status).toBe("pending");
  });

  it("rejects unknown tasks and completion while dependencies are incomplete", () => {
    const plan = TaskPlanSchema.parse({ tasks: [task("a"), task("b", "in_progress", ["a"])] });
    expect(() => updatePlanTask(plan, { taskId: "missing", status: "in_progress" })).toThrow(/unknown task/i);
    expect(() => updatePlanTask(plan, { taskId: "b", status: "completed" })).toThrow(/dependency/i);
  });

  it("requires work to enter in-progress before completion and keeps terminal states terminal", () => {
    const pending = TaskPlanSchema.parse({ tasks: [task("a")] });
    expect(() => updatePlanTask(pending, { taskId: "a", status: "completed" })).toThrow(/transition/i);

    const completed = TaskPlanSchema.parse({ tasks: [task("a", "completed")] });
    expect(() => updatePlanTask(completed, { taskId: "a", status: "in_progress" })).toThrow(/transition/i);
  });

  it("stores a result on terminal transitions", () => {
    const plan = TaskPlanSchema.parse({ tasks: [task("a", "in_progress")] });
    expect(updatePlanTask(plan, { taskId: "a", status: "completed", result: "verified" }).tasks[0])
      .toMatchObject({ status: "completed", result: "verified" });
  });
});

describe("normalizeAbandonedPlan", () => {
  it("normalizes an abandoned active task to cancelled", () => {
    const plan = TaskPlanSchema.parse({ tasks: [task("a", "in_progress"), task("b")] });
    expect(normalizeAbandonedPlan(plan).tasks).toEqual([
      expect.objectContaining({ id: "a", status: "cancelled", result: "Execution was abandoned" }),
      expect.objectContaining({ id: "b", status: "pending" }),
    ]);
  });
});
