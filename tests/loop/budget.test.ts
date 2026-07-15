import { describe, expect, it } from "vitest";

import { budgetDecision, extendBudget, rejectBudget } from "../../src/loop/budget.js";
import type { LoopState } from "../../src/loop/types.js";

function state(overrides: Partial<LoopState["budget"]> = {}): LoopState {
  return {
    version: 1,
    loopId: "loop-budget",
    goal: "finish the project",
    workspace: "C:/work/project",
    createdAt: "2026-07-15T00:00:00.000Z",
    updatedAt: "2026-07-15T00:00:00.000Z",
    status: "running",
    config: { cycleStep: 20, tokenStep: 5_000_000, isolation: "auto" },
    budget: {
      cyclesUsed: 0,
      inputTokens: 0,
      outputTokens: 0,
      cycleCheckpoint: 20,
      tokenCheckpoint: 5_000_000,
      approvals: [],
      ...overrides,
    },
    cycles: [],
  };
}

describe("loop budget checkpoints", () => {
  it("allows work below both checkpoints", () => {
    expect(budgetDecision(state({ cyclesUsed: 19, inputTokens: 4_000_000, outputTokens: 999_999 })))
      .toEqual({ kind: "allow" });
  });

  it("requests confirmation at or beyond each safe boundary", () => {
    expect(budgetDecision(state({ cyclesUsed: 20 }))).toEqual({ kind: "confirm", dimensions: ["cycles"] });
    expect(budgetDecision(state({ inputTokens: 5_000_001 }))).toEqual({ kind: "confirm", dimensions: ["tokens"] });
    expect(budgetDecision(state({ cyclesUsed: 21, inputTokens: 3_000_000, outputTokens: 2_000_000 })))
      .toEqual({ kind: "confirm", dimensions: ["cycles", "tokens"] });
  });

  it("extends by the original tranche on every approval", () => {
    const first = extendBudget(state({ inputTokens: 5_000_000 }), ["tokens"], "2026-07-15T01:00:00.000Z");
    expect(first.budget.tokenCheckpoint).toBe(10_000_000);
    const second = extendBudget({
      ...first,
      budget: { ...first.budget, inputTokens: 10_000_000 },
    }, ["tokens"], "2026-07-15T02:00:00.000Z");
    expect(second.budget.tokenCheckpoint).toBe(15_000_000);
    expect(second.budget.approvals.map((item) => [item.dimension, item.previousCheckpoint, item.newCheckpoint]))
      .toEqual([
        ["tokens", 5_000_000, 10_000_000],
        ["tokens", 10_000_000, 15_000_000],
      ]);
  });

  it("extends cycle and token checkpoints independently", () => {
    const next = extendBudget(state({ cyclesUsed: 20, inputTokens: 5_000_000 }), ["cycles", "tokens"], "2026-07-15T01:00:00.000Z");
    expect(next.budget.cycleCheckpoint).toBe(40);
    expect(next.budget.tokenCheckpoint).toBe(10_000_000);
  });

  it("records rejection as a terminal budget outcome", () => {
    expect(rejectBudget(state({ cyclesUsed: 20 }), "User stopped at cycle checkpoint")).toMatchObject({
      status: "budget_exhausted",
      terminalReason: "User stopped at cycle checkpoint",
    });
  });
});
