import { z } from "zod";

export const PlanTaskStatusSchema = z.enum([
  "pending",
  "in_progress",
  "completed",
  "failed",
  "blocked",
  "cancelled",
]);

export const PlanTaskSchema = z.object({
  id: z.string().trim().min(1),
  subject: z.string().trim().min(1),
  activeForm: z.string().trim().min(1),
  status: PlanTaskStatusSchema,
  dependencies: z.array(z.string().trim().min(1)),
  result: z.string().optional(),
}).strict();

export const TaskPlanSchema = z.object({
  tasks: z.array(PlanTaskSchema),
}).strict().superRefine((plan, context) => {
  const ids = new Set<string>();
  let activeTasks = 0;

  for (const [index, task] of plan.tasks.entries()) {
    if (ids.has(task.id)) {
      context.addIssue({ code: "custom", path: ["tasks", index, "id"], message: `Duplicate task id: ${task.id}` });
    }
    ids.add(task.id);
    if (task.status === "in_progress") activeTasks += 1;
  }

  if (activeTasks > 1) {
    context.addIssue({ code: "custom", path: ["tasks"], message: "Only one task may be in progress" });
  }

  for (const [index, task] of plan.tasks.entries()) {
    const dependencies = new Set<string>();
    for (const dependency of task.dependencies) {
      if (!ids.has(dependency)) {
        context.addIssue({ code: "custom", path: ["tasks", index, "dependencies"], message: `Unknown dependency: ${dependency}` });
      }
      if (dependencies.has(dependency)) {
        context.addIssue({ code: "custom", path: ["tasks", index, "dependencies"], message: `Duplicate dependency: ${dependency}` });
      }
      dependencies.add(dependency);
    }
    if (task.status === "completed") {
      const incomplete = task.dependencies.find((dependency) =>
        plan.tasks.find((candidate) => candidate.id === dependency)?.status !== "completed");
      if (incomplete !== undefined) {
        context.addIssue({
          code: "custom",
          path: ["tasks", index, "status"],
          message: `Task ${task.id} has an incomplete dependency: ${incomplete}`,
        });
      }
    }
  }

  if (ids.size === plan.tasks.length && hasCycle(plan.tasks)) {
    context.addIssue({ code: "custom", path: ["tasks"], message: "Task plan contains a cycle" });
  }
});

export const TaskUpdateInputSchema = z.object({
  taskId: z.string().trim().min(1),
  status: PlanTaskStatusSchema,
  result: z.string().optional(),
}).strict();

export type PlanTaskStatus = z.infer<typeof PlanTaskStatusSchema>;
export type PlanTask = z.infer<typeof PlanTaskSchema>;
export type TaskPlan = z.infer<typeof TaskPlanSchema>;
export type TaskUpdateInput = z.infer<typeof TaskUpdateInputSchema>;

export function updatePlanTask(plan: TaskPlan, input: TaskUpdateInput): TaskPlan {
  const update = TaskUpdateInputSchema.parse(input);
  const current = TaskPlanSchema.parse(plan);
  const index = current.tasks.findIndex((task) => task.id === update.taskId);
  if (index < 0) throw new Error(`Unknown task: ${update.taskId}`);

  const previousStatus = current.tasks[index]!.status;
  if (!isValidTransition(previousStatus, update.status)) {
    throw new Error(`Invalid task transition for ${update.taskId}: ${previousStatus} -> ${update.status}`);
  }

  if (update.status === "completed") {
    const incomplete = current.tasks[index]!.dependencies.find((dependency) =>
      current.tasks.find((task) => task.id === dependency)?.status !== "completed");
    if (incomplete !== undefined) throw new Error(`Task ${update.taskId} has an incomplete dependency: ${incomplete}`);
  }

  return TaskPlanSchema.parse({
    tasks: current.tasks.map((task, currentIndex) => currentIndex === index ? {
      ...task,
      status: update.status,
      ...(update.result === undefined ? {} : { result: update.result }),
    } : { ...task }),
  });
}

function isValidTransition(from: PlanTaskStatus, to: PlanTaskStatus): boolean {
  if (from === to) return true;
  if (from === "pending") return to === "in_progress" || to === "blocked" || to === "cancelled";
  if (from === "in_progress") {
    return to === "completed" || to === "failed" || to === "blocked" || to === "cancelled";
  }
  return false;
}

export function normalizeAbandonedPlan(plan: TaskPlan): TaskPlan {
  const current = TaskPlanSchema.parse(plan);
  return TaskPlanSchema.parse({
    tasks: current.tasks.map((task) => task.status === "in_progress" ? {
      ...task,
      status: "cancelled" as const,
      result: "Execution was abandoned",
    } : { ...task }),
  });
}

function hasCycle(tasks: readonly PlanTask[]): boolean {
  const indegree = new Map(tasks.map((task) => [task.id, task.dependencies.length]));
  const dependents = new Map<string, string[]>();
  for (const task of tasks) {
    for (const dependency of task.dependencies) {
      const items = dependents.get(dependency) ?? [];
      items.push(task.id);
      dependents.set(dependency, items);
    }
  }

  const ready = tasks.filter((task) => indegree.get(task.id) === 0).map((task) => task.id);
  let visited = 0;
  for (let index = 0; index < ready.length; index += 1) {
    const id = ready[index]!;
    visited += 1;
    for (const dependent of dependents.get(id) ?? []) {
      const next = (indegree.get(dependent) ?? 0) - 1;
      indegree.set(dependent, next);
      if (next === 0) ready.push(dependent);
    }
  }
  return visited !== tasks.length;
}
