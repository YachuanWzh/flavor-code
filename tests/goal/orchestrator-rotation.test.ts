import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { GoalOrchestrator } from "../../src/goal/orchestrator.js";
import type { GoalRuntimeEvent, GoalState } from "../../src/goal/types.js";
import { ModelRegistry } from "../../src/models/registry.js";
import { modelContentText, type ModelAdapter } from "../../src/models/types.js";
import { clearMemoryRotation, markMemoryRotation, memoryRotationActive } from "../../src/utils/memory-restart.js";

const roots: string[] = [];

afterEach(async () => {
  clearMemoryRotation();
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

  it("continues a saved verification checkpoint and finishes without rerunning the worker", async () => {
    const root = await workspace();
    const states: GoalState[] = [];
    const persistence = {
      save: async (state: GoalState) => { states.push(structuredClone(state)); },
      load: async () => structuredClone(states.at(-1)!),
    };
    let workerCalls = 0;
    const options = {
      workspace: root, registry: registry(), plannerModelId: "capture:main", classifierModelId: "capture:main",
      skepticCount: 1, maxRounds: 3, maxStallStreak: 2, idFactory: () => "goal-verify-rotate",
      now: () => "2026-08-25T00:00:00.000Z", persistence,
      runWorker: async function* () {
        workerCalls += 1;
        yield { type: "text" as const, text: "worker completed" };
        yield { type: "done" as const, usage: { inputTokens: 1, outputTokens: 1 } };
      },
      onMemoryCheckpoint: () => {
        if (states.at(-1)?.pendingVerification !== null && states.at(-1)?.pendingVerification !== undefined) {
          markMemoryRotation();
        }
      },
    };
    const interrupted = new GoalOrchestrator(options);
    for await (const event of interrupted.run({ goal: "fix it", signal: new AbortController().signal })) void event;
    expect(states.at(-1)).toMatchObject({ phase: "verifying", pendingVerification: { round: 1 } });
    expect(workerCalls).toBe(1);

    clearMemoryRotation();
    const { onMemoryCheckpoint: _checkpoint, ...resumeOptions } = options;
    const resumed = new GoalOrchestrator(resumeOptions);
    const events: GoalRuntimeEvent[] = [];
    for await (const event of resumed.resume({ goalId: "goal-verify-rotate", signal: new AbortController().signal })) events.push(event);
    expect(workerCalls).toBe(1);
    expect(events.some((event) => event.type === "goal-complete")).toBe(true);
    expect(states.at(-1)).toMatchObject({ status: "achieved", verifyRounds: 1, pendingVerification: null });
  });

  it("survives repeated round-boundary rotations and reaches the final verdict", async () => {
    const root = await workspace();
    const states: GoalState[] = [];
    const persistence = {
      save: async (state: GoalState) => { states.push(structuredClone(state)); },
      load: async () => structuredClone(states.at(-1)!),
    };
    const workerRounds: number[] = [];
    const make = (rotateAfter: number | undefined, hostPassed: boolean) => new GoalOrchestrator({
      workspace: root, registry: registry(), plannerModelId: "capture:main", classifierModelId: "capture:main",
      skepticCount: 1, maxRounds: 5, maxStallStreak: 4, idFactory: () => "goal-multi-rotate",
      now: () => "2026-08-25T00:00:00.000Z", persistence,
      runWorker: async function* ({ round }) {
        workerRounds.push(round);
        yield { type: "text", text: `work-${round}` };
        yield { type: "done", usage: { inputTokens: 1, outputTokens: 1 } };
      },
      verifyHost: async () => ({
        passed: hostPassed,
        summary: hostPassed ? "tests pass" : `tests still fail after round ${states.at(-1)?.workerRounds ?? 0}`,
        commands: [{ command: "npm", args: ["test"], exitCode: hostPassed ? 0 : 1 }],
      }),
      ...(rotateAfter === undefined ? {} : {
        onRoundBoundary: () => {
          if (states.at(-1)?.verifyRounds === rotateAfter) markMemoryRotation();
        },
      }),
    });

    for await (const event of make(1, false).run({ goal: "fix it", signal: new AbortController().signal })) void event;
    expect(states.at(-1)).toMatchObject({ status: "not_achieved", verifyRounds: 1 });
    clearMemoryRotation();
    for await (const event of make(2, false).resume({ goalId: "goal-multi-rotate", signal: new AbortController().signal })) void event;
    expect(states.at(-1)).toMatchObject({ status: "not_achieved", verifyRounds: 2 });
    clearMemoryRotation();
    const finalEvents: GoalRuntimeEvent[] = [];
    for await (const event of make(undefined, true).resume({ goalId: "goal-multi-rotate", signal: new AbortController().signal })) finalEvents.push(event);
    expect(workerRounds).toEqual([1, 2, 3]);
    expect(finalEvents.some((event) => event.type === "goal-complete")).toBe(true);
    expect(states.at(-1)).toMatchObject({ status: "achieved", verifyRounds: 3 });
  });
});
