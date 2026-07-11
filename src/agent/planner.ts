import { z } from "zod";

import type { HookBus } from "../hooks/bus.js";

export const TaskNodeSchema = z.object({
  id: z.string().trim().min(1),
  description: z.string().trim().min(1),
  dependencies: z.array(z.string().trim().min(1)),
  expectedOutputs: z.array(z.string().trim().min(1)),
  verification: z.array(z.string().trim().min(1)),
}).strict();

export const TaskGraphSchema = z.object({
  nodes: z.array(TaskNodeSchema),
}).strict().superRefine((graph, context) => {
  const ids = new Set<string>();
  for (const [index, task] of graph.nodes.entries()) {
    if (ids.has(task.id)) {
      context.addIssue({ code: "custom", path: ["nodes", index, "id"], message: `Duplicate task id: ${task.id}` });
    }
    ids.add(task.id);
  }
  for (const [index, task] of graph.nodes.entries()) {
    const dependencies = new Set<string>();
    for (const dependency of task.dependencies) {
      if (!ids.has(dependency)) {
        context.addIssue({ code: "custom", path: ["nodes", index, "dependencies"], message: `Unknown dependency: ${dependency}` });
      }
      if (dependencies.has(dependency)) {
        context.addIssue({ code: "custom", path: ["nodes", index, "dependencies"], message: `Duplicate dependency: ${dependency}` });
      }
      dependencies.add(dependency);
    }
  }
  if (ids.size === graph.nodes.length && hasCycle(graph.nodes)) {
    context.addIssue({ code: "custom", path: ["nodes"], message: "Task graph contains a cycle" });
  }
});

export type TaskNode = z.infer<typeof TaskNodeSchema>;
export type TaskGraph = z.infer<typeof TaskGraphSchema>;

export interface TaskPlannerOptions {
  hooks: HookBus;
}

export class TaskPlanner {
  readonly #hooks: HookBus;

  constructor(options: TaskPlannerOptions) {
    this.#hooks = options.hooks;
  }

  async plan(input: unknown, signal?: AbortSignal): Promise<TaskGraph> {
    let outcome: "completed" | "failed" | "cancelled" = "failed";
    let graph: TaskGraph | undefined;
    let primaryError: unknown;
    let hasPrimaryError = false;
    try {
      const before = await this.#hooks.emit({
        version: 1,
        type: "BeforePlan",
        payload: { graph: input },
      }, signal);
      if (before.decision === "deny") throw new Error(before.reason ?? "Planning denied by hook");
      signal?.throwIfAborted();
      graph = TaskGraphSchema.parse(before.updatedInput === undefined ? input : updatedGraph(before.updatedInput));
      outcome = "completed";
    } catch (error) {
      outcome = signal?.aborted ? "cancelled" : "failed";
      primaryError = error;
      hasPrimaryError = true;
    }
    try {
      await this.#hooks.emit({
        version: 1,
        type: "AfterPlan",
        payload: { outcome },
      });
    } catch (afterPlanError) {
      if (!hasPrimaryError) throw afterPlanError;
      attachAfterPlanError(primaryError, afterPlanError);
    }
    if (hasPrimaryError) throw primaryError;
    return graph!;
  }
}

function attachAfterPlanError(primary: unknown, afterPlanError: unknown): void {
  try {
    if ((typeof primary !== "object" && typeof primary !== "function") || primary === null || !Object.isExtensible(primary)) return;
    Object.defineProperty(primary, "afterPlanError", {
      value: afterPlanError,
      configurable: true,
    });
    if (!("cause" in primary)) {
      Object.defineProperty(primary, "cause", {
        value: afterPlanError,
        configurable: true,
      });
    }
  } catch {
    // Secondary diagnostic metadata must never replace the primary error.
  }
}

function updatedGraph(input: unknown): unknown {
  if (typeof input !== "object" || input === null || !("graph" in input)) {
    throw new Error("BeforePlan updatedInput must contain graph");
  }
  return input.graph;
}

function hasCycle(nodes: readonly TaskNode[]): boolean {
  const indegree = new Map(nodes.map((task) => [task.id, task.dependencies.length]));
  const dependents = new Map<string, string[]>();
  for (const task of nodes) {
    for (const dependency of task.dependencies) {
      const list = dependents.get(dependency) ?? [];
      list.push(task.id);
      dependents.set(dependency, list);
    }
  }
  const ready = nodes.filter((task) => indegree.get(task.id) === 0).map((task) => task.id);
  let visited = 0;
  for (let cursor = 0; cursor < ready.length; cursor += 1) {
    const id = ready[cursor]!;
    visited += 1;
    for (const dependent of dependents.get(id) ?? []) {
      const next = (indegree.get(dependent) ?? 0) - 1;
      indegree.set(dependent, next);
      if (next === 0) ready.push(dependent);
    }
  }
  return visited !== nodes.length;
}
