import {
  TaskPlanSchema,
  TaskUpdateInputSchema,
  updatePlanTask,
  type TaskPlan,
  type TaskUpdateInput,
} from "./task-plan.js";
import type { ToolDefinition } from "../tools/types.js";

export const MAIN_TASK_TOOL_NAMES = new Set(["Task", "TaskPlan", "TaskUpdate"]);

export interface TaskPlanToolOptions {
  getPlan(): TaskPlan | undefined;
  commit(plan: TaskPlan): void | Promise<void>;
}

export function createTaskPlanTools(options: TaskPlanToolOptions): readonly [
  ToolDefinition<TaskPlan>,
  ToolDefinition<TaskUpdateInput>,
] {
  const planTool: ToolDefinition<TaskPlan> = {
    name: "TaskPlan",
    description: "Create or replace the main-agent plan for complex multi-step work",
    inputSchema: TaskPlanSchema,
    paths: () => [],
    execute: async (input, signal) => {
      signal.throwIfAborted();
      const plan = TaskPlanSchema.parse(input);
      await options.commit(plan);
      return plan;
    },
  };

  const updateTool: ToolDefinition<TaskUpdateInput> = {
    name: "TaskUpdate",
    description: "Update one task immediately before starting it or after it reaches a terminal state",
    inputSchema: TaskUpdateInputSchema,
    paths: () => [],
    execute: async (input, signal) => {
      signal.throwIfAborted();
      const plan = options.getPlan();
      if (plan === undefined) throw new Error("No task plan exists; create one with TaskPlan first");
      const next = updatePlanTask(plan, input);
      await options.commit(next);
      return next;
    },
  };

  return [planTool, updateTool];
}
