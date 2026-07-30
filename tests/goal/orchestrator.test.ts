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
});
