import { LoopStateSchema, type LoopState } from "./types.js";

export type BudgetDimension = "cycles" | "tokens";
export type BudgetDecision =
  | { kind: "allow" }
  | { kind: "confirm"; dimensions: BudgetDimension[] };

export function budgetDecision(input: LoopState): BudgetDecision {
  const state = LoopStateSchema.parse(input);
  const dimensions: BudgetDimension[] = [];
  if (state.budget.cyclesUsed >= state.budget.cycleCheckpoint) dimensions.push("cycles");
  if (state.budget.inputTokens + state.budget.outputTokens >= state.budget.tokenCheckpoint) dimensions.push("tokens");
  return dimensions.length === 0 ? { kind: "allow" } : { kind: "confirm", dimensions };
}

export function extendBudget(
  input: LoopState,
  dimensions: readonly BudgetDimension[],
  approvedAt: string,
): LoopState {
  const state = LoopStateSchema.parse(input);
  const selected = new Set(dimensions);
  const approvals = [...state.budget.approvals];
  let cycleCheckpoint = state.budget.cycleCheckpoint;
  let tokenCheckpoint = state.budget.tokenCheckpoint;
  if (selected.has("cycles")) {
    const previousCheckpoint = cycleCheckpoint;
    cycleCheckpoint += state.config.cycleStep;
    approvals.push({
      dimension: "cycles", previousCheckpoint, newCheckpoint: cycleCheckpoint,
      usage: state.budget.cyclesUsed, approvedAt,
    });
  }
  if (selected.has("tokens")) {
    const previousCheckpoint = tokenCheckpoint;
    tokenCheckpoint += state.config.tokenStep;
    approvals.push({
      dimension: "tokens", previousCheckpoint, newCheckpoint: tokenCheckpoint,
      usage: state.budget.inputTokens + state.budget.outputTokens, approvedAt,
    });
  }
  return LoopStateSchema.parse({
    ...state,
    updatedAt: approvedAt,
    budget: { ...state.budget, cycleCheckpoint, tokenCheckpoint, approvals },
  });
}

export function rejectBudget(input: LoopState, terminalReason: string): LoopState {
  const state = LoopStateSchema.parse(input);
  return LoopStateSchema.parse({ ...state, status: "budget_exhausted", terminalReason });
}
