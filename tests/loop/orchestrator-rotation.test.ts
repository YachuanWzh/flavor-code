import { describe, expect, it } from "vitest";

import type { AgentEvent } from "../../src/agent/types.js";
import { LoopOrchestrator, type LoopPersistence, type LoopRuntimeEvent } from "../../src/loop/orchestrator.js";
import type { LoopEvent, LoopState, LoopVerificationEvidence } from "../../src/loop/types.js";
import { markMemoryRotation, memoryRotationActive } from "../../src/utils/memory-restart.js";

/**
 * Isolated on purpose: markMemoryRotation() flips a one-way module global, so
 * a boundary-rotation test would poison every later orchestrator run in the
 * same file (each would return at the first boundary). Vitest gives each file
 * a fresh module registry, so this file holds exactly one rotation scenario.
 */

class MemoryPersistence implements LoopPersistence {
  states: LoopState[] = [];
  events: LoopEvent[] = [];
  async create(state: LoopState) { this.states.push(structuredClone(state)); }
  async save(state: LoopState) { this.states.push(structuredClone(state)); }
  async append(event: LoopEvent) { this.events.push(structuredClone(event)); }
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
});
