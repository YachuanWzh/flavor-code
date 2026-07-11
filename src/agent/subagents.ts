import { z } from "zod";

import type { HookBus } from "../hooks/bus.js";
import { TaskGraphSchema, type TaskGraph, type TaskNode } from "./planner.js";

export const SubagentResultSchema = z.object({
  taskId: z.string().min(1),
  status: z.enum(["completed", "failed", "blocked"]),
  summary: z.string(),
  filesChanged: z.array(z.string()),
  commandsRun: z.array(z.object({
    command: z.string(),
    exitCode: z.number().int().nullable(),
    summary: z.string(),
  }).strict()),
  verification: z.array(z.object({
    name: z.string(),
    passed: z.boolean(),
    details: z.string(),
  }).strict()),
  artifacts: z.array(z.string()),
  risks: z.array(z.string()),
  suggestedNextSteps: z.array(z.string()),
}).strict();

export type SubagentResult = z.infer<typeof SubagentResultSchema>;
export type SubagentState = "pending" | "running" | "completed" | "failed" | "blocked";

export interface SubagentExecution {
  attempt: 1 | 2;
  signal: AbortSignal;
}

export interface SubagentSchedulerOptions {
  maxSubagents: number;
  hooks: HookBus;
  execute(task: TaskNode, execution: SubagentExecution): Promise<unknown>;
  onResult?(result: SubagentResult): void | Promise<void>;
}

export interface SubagentRunResult {
  states: Record<string, SubagentState>;
  results: Record<string, SubagentResult>;
}

interface Completion {
  id: string;
  result: SubagentResult;
}

export class SubagentScheduler {
  readonly #options: SubagentSchedulerOptions;

  constructor(options: SubagentSchedulerOptions) {
    if (!Number.isInteger(options.maxSubagents) || options.maxSubagents <= 0) {
      throw new Error("maxSubagents must be a positive integer");
    }
    this.#options = options;
  }

  async run(input: TaskGraph, externalSignal?: AbortSignal): Promise<SubagentRunResult> {
    const graph = TaskGraphSchema.parse(input);
    const controller = new AbortController();
    const signal = externalSignal === undefined
      ? controller.signal
      : AbortSignal.any([controller.signal, externalSignal]);
    const states = new Map<string, SubagentState>(graph.nodes.map((task) => [task.id, "pending"]));
    const results = new Map<string, SubagentResult>();
    const running = new Map<string, Promise<Completion>>();

    try {
      while (statesHaveWork(states)) {
        signal.throwIfAborted();
        this.#blockDescendants(graph, states, results);
        for (const task of graph.nodes) {
          if (running.size >= this.#options.maxSubagents) break;
          if (states.get(task.id) !== "pending" || !isReady(task, states)) continue;
          states.set(task.id, "running");
          running.set(task.id, this.#runTask(task, signal));
        }

        if (running.size === 0) {
          this.#blockDescendants(graph, states, results);
          if (statesHaveWork(states)) throw new Error("Scheduler reached an invalid state with no runnable tasks");
          break;
        }

        const completion = await Promise.race(running.values());
        signal.throwIfAborted();
        running.delete(completion.id);
        results.set(completion.id, completion.result);
        states.set(completion.id, completion.result.status);
        await this.#options.onResult?.(completion.result);
      }
      return orderedOutcome(graph, states, results);
    } finally {
      controller.abort(new Error("Subagent scheduler stopped"));
    }
  }

  #blockDescendants(graph: TaskGraph, states: Map<string, SubagentState>, results: Map<string, SubagentResult>): void {
    let changed = true;
    while (changed) {
      changed = false;
      for (const task of graph.nodes) {
        if (states.get(task.id) !== "pending") continue;
        if (!task.dependencies.some((id) => ["failed", "blocked"].includes(states.get(id) ?? "pending"))) continue;
        states.set(task.id, "blocked");
        results.set(task.id, syntheticResult(task, "blocked", "Blocked by a failed dependency"));
        changed = true;
      }
    }
  }

  async #runTask(task: TaskNode, signal: AbortSignal): Promise<Completion> {
    let failure: unknown;
    let completion: Completion | undefined;
    try {
      const start = await this.#options.hooks.emit({
        version: 1,
        type: "SubagentStart",
        payload: { taskId: task.id },
      }, signal);
      if (start.decision === "deny") throw new Error(start.reason ?? `Subagent ${task.id} denied by hook`);
      for (const attempt of [1, 2] as const) {
        signal.throwIfAborted();
        const raw = await awaitWithSignal(this.#options.execute(task, { attempt, signal }), signal);
        const parsed = SubagentResultSchema.safeParse(raw);
        if (parsed.success && parsed.data.taskId === task.id) {
          completion = { id: task.id, result: parsed.data };
          break;
        }
        failure = parsed.success
          ? new Error(`Subagent result taskId ${parsed.data.taskId} does not match ${task.id}`)
          : parsed.error;
      }
      completion ??= {
        id: task.id,
        result: syntheticResult(task, "failed", `Invalid structured result after repair: ${message(failure)}`),
      };
    } catch (error) {
      failure = error;
      if (!signal.aborted) completion = { id: task.id, result: syntheticResult(task, "failed", message(error)) };
    } finally {
      try {
        await this.#options.hooks.emit({
          version: 1,
          type: "SubagentStop",
          payload: {
            taskId: task.id,
            status: completion?.result.status ?? "failed",
            ...(failure === undefined ? {} : { error: message(failure) }),
          },
        });
      } catch (stopError) {
        if (!signal.aborted) {
          failure = stopError;
          completion = { id: task.id, result: syntheticResult(task, "failed", message(stopError)) };
        }
      }
    }
    if (signal.aborted) throw signal.reason;
    return completion ?? { id: task.id, result: syntheticResult(task, "failed", message(failure)) };
  }
}

function isReady(task: TaskNode, states: ReadonlyMap<string, SubagentState>): boolean {
  return task.dependencies.every((dependency) => states.get(dependency) === "completed");
}

function statesHaveWork(states: ReadonlyMap<string, SubagentState>): boolean {
  return [...states.values()].some((state) => state === "pending" || state === "running");
}

function syntheticResult(task: TaskNode, status: "failed" | "blocked", summary: string): SubagentResult {
  return {
    taskId: task.id,
    status,
    summary,
    filesChanged: [],
    commandsRun: [],
    verification: [],
    artifacts: [],
    risks: [summary],
    suggestedNextSteps: [],
  };
}

function orderedOutcome(
  graph: TaskGraph,
  states: ReadonlyMap<string, SubagentState>,
  results: ReadonlyMap<string, SubagentResult>,
): SubagentRunResult {
  const orderedStates: Record<string, SubagentState> = {};
  const orderedResults: Record<string, SubagentResult> = {};
  for (const task of graph.nodes) {
    orderedStates[task.id] = states.get(task.id)!;
    const result = results.get(task.id);
    if (result !== undefined) orderedResults[task.id] = result;
  }
  return { states: orderedStates, results: orderedResults };
}

function awaitWithSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => { signal.removeEventListener("abort", onAbort); resolve(value); },
      (error: unknown) => { signal.removeEventListener("abort", onAbort); reject(error); },
    );
  });
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
