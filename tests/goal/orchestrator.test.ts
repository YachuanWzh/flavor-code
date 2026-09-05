import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { GoalOrchestrator } from "../../src/goal/orchestrator.js";
import type { GoalState } from "../../src/goal/types.js";
import { ModelRegistry } from "../../src/models/registry.js";
import { modelContentText, type ModelAdapter } from "../../src/models/types.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "flavor-goal-"));
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

/** In-memory goal store that can also reload state, so resume() has a source. */
class GoalMemoryStore {
  states: GoalState[] = [];
  async save(state: GoalState): Promise<void> { this.states.push(structuredClone(state)); }
  async load(goalId: string): Promise<GoalState> {
    for (let index = this.states.length - 1; index >= 0; index -= 1) {
      const state = this.states[index]!;
      if (state.id === goalId) return structuredClone(state);
    }
    throw new Error(`Goal "${goalId}" was not found`);
  }
}

type GoalOptions = ConstructorParameters<typeof GoalOrchestrator>[0];

function makeOrchestrator(root: string, store: GoalMemoryStore, overrides: Partial<GoalOptions> = {}): GoalOrchestrator {
  return new GoalOrchestrator({
    workspace: root,
    registry: registry(),
    plannerModelId: "capture:main",
    classifierModelId: "capture:main",
    skepticCount: 1,
    maxRounds: 3,
    maxStallStreak: 2,
    now: () => "2026-07-26T00:00:00.000Z",
    persistence: store,
    runWorker: async function* () {
      yield { type: "text", text: "Implemented and verified." };
      yield { type: "done", usage: { inputTokens: 5, outputTokens: 3 } };
    },
    ...overrides,
  });
}

/** A round-1-complete state that stopped short of achieving the goal. */
function seededNotAchieved(): GoalState {
  return {
    id: "goal-test",
    objective: "fix it",
    phase: "verifying",
    status: "not_achieved",
    plan: {
      kind: "code-change",
      criteria: [{ id: 1, description: "The requested behavior works", type: "gating" }],
      verificationPlan: "Run focused tests.",
      nonGoals: [],
      assumedScope: [],
      approach: "Inspect, implement, verify.",
      checklist: ["Inspect", "Implement", "Verify"],
    },
    planPath: null,
    verifyRounds: 1,
    workerRounds: 1,
    lastGaps: [{ criterion: "ac-1", description: "still broken", blocking: "model_fixable" }],
    gapFingerprint: "fp1",
    stallStreak: 1,
    contractHash: "a".repeat(64),
    evidenceRounds: [],
    createdAt: "2026-07-26T00:00:00.000Z",
    updatedAt: "2026-07-26T00:00:00.000Z",
  };
}

describe("GoalOrchestrator runtime events", () => {
  it("forwards detailed worker events and persists every goal phase", async () => {
    const root = await workspace();
    const states: GoalState[] = [];
    const orchestrator = new GoalOrchestrator({
      workspace: root,
      registry: registry(),
      plannerModelId: "capture:main",
      classifierModelId: "capture:main",
      skepticCount: 3,
      maxRounds: 2,
      maxStallStreak: 2,
      idFactory: () => "goal-test",
      now: () => "2026-07-26T00:00:00.000Z",
      persistence: { save: async (state) => { states.push(structuredClone(state)); } },
      runWorker: async function* () {
        yield { type: "model-start", id: "worker-model" };
        yield { type: "tool-start", id: "read-1", name: "Read", input: { path: "src/a.ts" } };
        yield {
          type: "tool-end", id: "read-1", name: "Read",
          result: { ok: true, output: "contents" },
        };
        yield { type: "text", text: "Implemented and verified." };
        yield { type: "model-end", id: "worker-model" };
        yield { type: "done", usage: { inputTokens: 5, outputTokens: 3 } };
      },
    });

    const events = [];
    for await (const event of orchestrator.run({
      goal: "fix it",
      signal: new AbortController().signal,
    })) events.push(event);

    expect(events.filter((event) => event.type === "goal-worker-event").map((event) =>
      event.type === "goal-worker-event" ? event.event.type : "wrong")).toEqual([
      "model-start", "tool-start", "tool-end", "text", "model-end", "done",
    ]);
    expect(states.map(({ phase, status }) => `${phase}:${status}`)).toEqual(expect.arrayContaining([
      "planning:active",
      "executing:active",
      "verifying:active",
      "complete:achieved",
    ]));
    expect(states.at(-1)).toMatchObject({
      id: "goal-test", objective: "fix it", phase: "complete", status: "achieved",
      workerRounds: 1, verifyRounds: 1,
    });
  });

  it("treats a yielded worker error as a failed goal", async () => {
    const root = await workspace();
    const orchestrator = new GoalOrchestrator({
      workspace: root,
      registry: registry(),
      plannerModelId: "capture:main",
      classifierModelId: "capture:main",
      skepticCount: 1,
      maxRounds: 1,
      maxStallStreak: 1,
      runWorker: async function* () {
        yield { type: "error", error: { code: "network", message: "worker disconnected" } };
      },
    });

    const events = [];
    for await (const event of orchestrator.run({
      goal: "fix it",
      signal: new AbortController().signal,
    })) events.push(event);

    expect(events).toContainEqual(expect.objectContaining({
      type: "goal-worker-event",
      event: expect.objectContaining({ type: "error" }),
    }));
    expect(events.at(-1)).toEqual({
      type: "goal-failed",
      reason: "Worker error in round 1: worker disconnected",
    });
    expect(events.some((event) => event.type === "goal-verification-start")).toBe(false);
  });

  it("cannot complete a code goal when deterministic host verification fails", async () => {
    const root = await workspace();
    const orchestrator = new GoalOrchestrator({
      workspace: root,
      registry: registry(),
      plannerModelId: "capture:main",
      classifierModelId: "capture:main",
      skepticCount: 1,
      maxRounds: 1,
      maxStallStreak: 2,
      verifyHost: async () => ({
        passed: false,
        summary: "npm test failed with exit code 1",
        commands: [{ command: "npm", args: ["test"], exitCode: 1 }],
      }),
      runWorker: async function* () {
        yield { type: "text", text: "claimed success" };
        yield { type: "done", usage: { inputTokens: 1, outputTokens: 1 } };
      },
    });
    const events = [];
    for await (const event of orchestrator.run({ goal: "fix it", signal: new AbortController().signal })) events.push(event);

    expect(events).toContainEqual(expect.objectContaining({
      type: "goal-verdict",
      outcome: expect.objectContaining({ type: "not_achieved", summary: expect.stringContaining("npm test failed") }),
    }));
    expect(events.some((event) => event.type === "goal-complete")).toBe(false);
  });

  it("leaves the goal resumable when the worker trips the hard heap guard", async () => {
    const root = await workspace();
    const store = new GoalMemoryStore();
    const orchestrator = makeOrchestrator(root, store, {
      idFactory: () => "goal-test",
      runWorker: async function* () {
        yield { type: "error", error: { code: "memory_pressure", message: "Heap usage reached 80% of the V8 limit" } };
      },
    });
    const events = [];
    for await (const event of orchestrator.run({ goal: "fix it", signal: new AbortController().signal })) events.push(event);
    // The interrupted round is not terminalized; the relaunched process resumes it.
    expect(events.some((event) => event.type === "goal-failed")).toBe(false);
    expect(events.some((event) => event.type === "goal-complete")).toBe(false);
    expect(store.states.at(-1)).toMatchObject({ status: "active", phase: "executing", workerRounds: 1, verifyRounds: 0 });
  });

  it("resumes an interrupted goal and completes it on a fresh heap", async () => {
    const root = await workspace();
    const store = new GoalMemoryStore();
    const signal = new AbortController().signal;
    // Phase 1: round 1 is interrupted by the hard heap guard mid-worker.
    const interrupted = makeOrchestrator(root, store, {
      idFactory: () => "goal-test",
      runWorker: async function* () {
        yield { type: "error", error: { code: "memory_pressure", message: "heap guard" } };
      },
    });
    for await (const event of interrupted.run({ goal: "fix it", signal })) void event;
    expect(store.states.at(-1)).toMatchObject({ status: "active", workerRounds: 1, verifyRounds: 0 });

    // Phase 2: the relaunched process resumes the same goal id and finishes round 1.
    const resumed = makeOrchestrator(root, store, { idFactory: () => "goal-test" });
    const events = [];
    for await (const event of resumed.resume({ goalId: "goal-test", signal })) events.push(event);
    // verifyRounds(0) < workerRounds(1): the interrupted round 1 runs again.
    expect(events[0]).toMatchObject({ type: "goal-resumed", goalId: "goal-test", round: 1 });
    expect(events.some((event) => event.type === "goal-complete")).toBe(true);
    expect(store.states.at(-1)).toMatchObject({ status: "achieved", phase: "complete" });
  });

  it("advances past a fully verified round instead of replaying it on resume", async () => {
    const root = await workspace();
    const store = new GoalMemoryStore();
    store.states.push(seededNotAchieved());
    const resumed = makeOrchestrator(root, store, { idFactory: () => "goal-test", maxRounds: 3 });
    const events = [];
    for await (const event of resumed.resume({ goalId: "goal-test", signal: new AbortController().signal })) events.push(event);
    // verifyRounds(1) >= workerRounds(1): round 1 is done, so resume starts at round 2.
    expect(events[0]).toMatchObject({ type: "goal-resumed", goalId: "goal-test", round: 2 });
    expect(events.some((event) => event.type === "goal-complete")).toBe(true);
  });
});
