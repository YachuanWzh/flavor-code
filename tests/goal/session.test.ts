import { describe, expect, it } from "vitest";

import type { GoalRuntimeEvent } from "../../src/goal/types.js";
import { runGoalSession } from "../../src/production.js";

function orchestrator(events: readonly GoalRuntimeEvent[]) {
  return {
    async *run() {
      yield* events;
    },
  };
}

describe("runGoalSession", () => {
  it("uses neutral notices, forwards worker details, and emits one enclosing done", async () => {
    const events: GoalRuntimeEvent[] = [
      {
        type: "goal-plan-created",
        plan: {
          kind: "code-change",
          criteria: [{ id: 1, description: "works", type: "gating" }],
          verificationPlan: "test",
          nonGoals: [],
          assumedScope: [],
        },
        planPath: "C:\\work\\.flavor\\goal-plan.md",
      },
      { type: "goal-worker-start", round: 1 },
      {
        type: "goal-worker-event",
        round: 1,
        event: { type: "tool-start", id: "read", name: "Read", input: { path: "src/a.ts" } },
      },
      {
        type: "goal-worker-event",
        round: 1,
        event: { type: "done", usage: { inputTokens: 3, outputTokens: 2 } },
      },
      { type: "goal-verification-start", round: 1 },
      { type: "goal-complete", summary: "verified" },
    ];

    const output = [];
    for await (const event of runGoalSession(
      orchestrator(events) as never,
      "fix it",
      new AbortController().signal,
    )) output.push(event);

    expect(output.some((event) => event.type === "warning")).toBe(false);
    expect(output).toContainEqual(expect.objectContaining({ type: "notice", message: expect.stringContaining("Goal plan created") }));
    expect(output).toContainEqual(expect.objectContaining({ type: "tool-start", name: "Read" }));
    expect(output).toContainEqual({
      type: "usage",
      inputTokens: 3,
      outputTokens: 2,
      totalInputTokens: 3,
      totalOutputTokens: 2,
    });
    expect(output.filter((event) => event.type === "done")).toHaveLength(1);
  });
});
