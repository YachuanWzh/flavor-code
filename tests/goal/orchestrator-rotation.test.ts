import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { GoalOrchestrator } from "../../src/goal/orchestrator.js";
import type { GoalRuntimeEvent, GoalState } from "../../src/goal/types.js";
import { ModelRegistry } from "../../src/models/registry.js";
import { modelContentText, type ModelAdapter } from "../../src/models/types.js";
import { markMemoryRotation, memoryRotationActive } from "../../src/utils/memory-restart.js";

/**
 * Isolated on purpose: markMemoryRotation() flips a one-way module global, so a
 * boundary-rotation test would poison every later orchestrator run in the same
 * file. Vitest gives each file a fresh module registry, so this file holds
 * exactly one rotation scenario.
 */

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "flavor-goal-rot-"));
  roots.push(root);
  return root;
}

function registry(): ModelRegistry {
  const adapter: ModelAdapter = {
    async *stream(request) {
      const prompt = modelContentText(request.messages.at(-1)?.content ?? "");
      if (prompt.includes("goal planner")) {
        yield { type: "text", text: JSON.stringify({
          kind: "code-change",
          approach: "Inspect, implement, and verify.",
          checklist: ["Inspect", "Implement", "Verify"],
          criteria: [{ id: 1, description: "The requested behavior works", type: "gating" }],
          verificationPlan: "Run focused tests.",
          nonGoals: [],
          assumedScope: [],
        }) };
      } else {
        yield { type: "text", text: JSON.stringify({ refuted: false, gaps: [] }) };
      }
      yield { type: "done", usage: { inputTokens: 1, outputTokens: 1 } };
    },
  };
  return new ModelRegistry().register("capture", adapter);
}

describe("GoalOrchestrator boundary heap rotation", () => {
  it("stops cleanly at the first round boundary and leaves the goal resumable", async () => {
    const root = await workspace();
    const states: GoalState[] = [];
    const orchestrator = new GoalOrchestrator({
      workspace: root,
      registry: registry(),
      plannerModelId: "capture:main",
      classifierModelId: "capture:main",
      skepticCount: 1,
      maxRounds: 3,
      maxStallStreak: 2,
      idFactory: () => "goal-rotate",
      now: () => "2026-08-25T00:00:00.000Z",
      persistence: { save: async (state) => { states.push(structuredClone(state)); } },
      // Production rotates onto a fresh heap here, before the round's work starts.
      onRoundBoundary: () => { markMemoryRotation(); },
      runWorker: async function* () {
        yield { type: "text", text: "work" };
        yield { type: "done", usage: { inputTokens: 1, outputTokens: 1 } };
      },
    });

    const events: GoalRuntimeEvent[] = [];
    for await (const event of orchestrator.run({ goal: "fix it", signal: new AbortController().signal })) events.push(event);

    expect(memoryRotationActive()).toBe(true);
    // Planning finished and was persisted, but no round ran and nothing terminalized.
    expect(events.some((event) => event.type === "goal-plan-created")).toBe(true);
    expect(events.some((event) => event.type === "goal-failed")).toBe(false);
    expect(events.some((event) => event.type === "goal-complete")).toBe(false);
    expect(states.at(-1)).toMatchObject({ status: "active", phase: "executing", workerRounds: 0, verifyRounds: 0 });
  });
});
