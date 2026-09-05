import { afterEach, describe, expect, it } from "vitest";

import type { AgentEvent } from "../../src/agent/types.js";
import { LoopOrchestrator, type LoopPersistence, type LoopRuntimeEvent } from "../../src/loop/orchestrator.js";
import type { LoopEvent, LoopState, LoopVerificationEvidence } from "../../src/loop/types.js";
import { clearMemoryRotation, markMemoryRotation, memoryRotationActive } from "../../src/utils/memory-restart.js";

afterEach(() => clearMemoryRotation());

class MemoryPersistence implements LoopPersistence {
  states: LoopState[] = [];
  events: LoopEvent[] = [];
  async create(state: LoopState) { this.states.push(structuredClone(state)); }
  async save(state: LoopState) { this.states.push(structuredClone(state)); }
  async append(event: LoopEvent) { this.events.push(structuredClone(event)); }
  async load(): Promise<LoopState> { return structuredClone(this.states.at(-1)!); }
}

function worker(events: AgentEvent[]): AsyncIterable<AgentEvent> {
  return (async function* () { yield* events; })();
}

function verification(passed: boolean, summary: string): LoopVerificationEvidence {
  return { passed, summary, commands: [] };
}

async function collect(source: AsyncIterable<LoopRuntimeEvent>): Promise<LoopRuntimeEvent[]> {
  const result: LoopRuntimeEvent[] = [];
  for await (const event of source) result.push(event);
  return result;
}

describe("LoopOrchestrator boundary heap rotation", () => {
  it("stops cleanly at a cycle boundary and leaves the loop resumable", async () => {
    const persistence = new MemoryPersistence();
    let boundaries = 0;
    const orchestrator = new LoopOrchestrator({
      workspace: "C:/work/project",
      config: { maxCycles: 20, maxTokens: 500_000, isolation: "auto" },
      persistence,
      now: () => "2026-08-25T00:00:00.000Z",
      idFactory: () => "loop-rotate",
      prepareWorkspace: async () => ({ kind: "ready", workspace: { root: "C:/work/project", mode: "current" } }),
      inferVerification: async () => ({ commands: [{ label: "test", command: "npm", args: ["test"] }] }),
      runWorker: () => worker([
        { type: "usage", inputTokens: 10, outputTokens: 5, totalInputTokens: 10, totalOutputTokens: 5 },
        { type: "done", usage: { inputTokens: 10, outputTokens: 5 } },
      ]),
      // Cycle 1 fails verification so the loop reaches a second boundary.
      runVerifier: async () => verification(false, "still failing"),
      confirmBudget: async () => "approved",
      fingerprint: async () => "fingerprint",
      // The second cycle boundary is where production rotates onto a fresh heap.
      onCycleBoundary: () => { boundaries += 1; if (boundaries === 2) markMemoryRotation(); },
    });

    const events = await collect(orchestrator.run({ goal: "fix tests", signal: new AbortController().signal }));

    expect(boundaries).toBe(2);
    expect(memoryRotationActive()).toBe(true);
    // No terminal event: the loop is mid-flight, parked for the relaunched process.
    expect(events.some((event) => event.type === "loop-terminal")).toBe(false);
    // The last persisted state is still running with cycle 1 fully accounted for.
    expect(persistence.states.at(-1)).toMatchObject({ status: "running", budget: { cyclesUsed: 1 } });
  });

  it("survives repeated cycle rotations and eventually completes", async () => {
    const persistence = new MemoryPersistence();
    const workerCycles: number[] = [];
    const make = (rotateAfter: number | undefined, verifierPassed: boolean) => new LoopOrchestrator({
      workspace: "C:/work/project",
      config: { maxCycles: 20, maxTokens: 500_000, isolation: "auto" },
      persistence,
      now: () => "2026-08-25T00:00:00.000Z",
      idFactory: () => "loop-multi-rotate",
      prepareWorkspace: async () => ({ kind: "ready", workspace: { root: "C:/work/project", mode: "current" } }),
      inferVerification: async () => ({ commands: [{ label: "test", command: "npm", args: ["test"] }] }),
      runWorker: ({ cycle }) => {
        workerCycles.push(cycle);
        return worker([
          { type: "usage", inputTokens: 10, outputTokens: 5, totalInputTokens: 10, totalOutputTokens: 5 },
          { type: "done", usage: { inputTokens: 10, outputTokens: 5 } },
        ]);
      },
      runVerifier: async () => verification(verifierPassed, verifierPassed ? "passed" : `failed-${persistence.states.at(-1)?.budget.cyclesUsed ?? 0}`),
      confirmBudget: async () => "approved",
      fingerprint: async () => `fingerprint-${persistence.states.at(-1)?.budget.cyclesUsed ?? 0}`,
      ...(rotateAfter === undefined ? {} : {
        onCycleBoundary: () => {
          if (persistence.states.at(-1)?.budget.cyclesUsed === rotateAfter) markMemoryRotation();
        },
      }),
    });

    await collect(make(1, false).run({ goal: "fix tests", signal: new AbortController().signal }));
    expect(persistence.states.at(-1)).toMatchObject({ status: "running", budget: { cyclesUsed: 1 } });
    clearMemoryRotation();
    await collect(make(2, false).resume({ loopId: "loop-multi-rotate", signal: new AbortController().signal }));
    expect(persistence.states.at(-1)).toMatchObject({ status: "running", budget: { cyclesUsed: 2 } });
    clearMemoryRotation();
    const finalEvents = await collect(make(undefined, true).resume({ loopId: "loop-multi-rotate", signal: new AbortController().signal }));
    expect(workerCycles).toEqual([1, 2, 3]);
    expect(finalEvents.at(-1)).toMatchObject({ type: "loop-terminal", status: "succeeded" });
    expect(persistence.states.at(-1)).toMatchObject({ status: "succeeded", budget: { cyclesUsed: 3 } });
  });
});
