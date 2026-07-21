import { z } from "zod";

// ──── Goal State Machine ────

export const GoalPhaseSchema = z.enum([
  "idle", "planning", "executing", "verifying", "complete",
]);

export const GoalStatusSchema = z.enum([
  "active", "paused", "achieved", "not_achieved", "blocked", "failed",
]);

export type GoalPhase = z.infer<typeof GoalPhaseSchema>;
export type GoalStatus = z.infer<typeof GoalStatusSchema>;

// ──── Plan Structure ────

export const AcceptanceCriterionSchema = z.object({
  id: z.number().int().positive(),
  description: z.string().min(1),
  type: z.enum(["gating", "evidence"]),
}).strict();

export type AcceptanceCriterion = z.infer<typeof AcceptanceCriterionSchema>;

export const PlanSchema = z.object({
  kind: z.enum(["code-change", "analysis", "research"]),
  criteria: z.array(AcceptanceCriterionSchema).min(1).max(32),
  verificationPlan: z.string().min(1),
  nonGoals: z.array(z.string()).max(16),
  assumedScope: z.array(z.string()).max(16),
  approach: z.string().optional(),
  checklist: z.array(z.string()).max(32).optional(),
}).strict();

export type Plan = z.infer<typeof PlanSchema>;

// ──── Verdict / Gap ────

export const GapSchema = z.object({
  criterion: z.string().min(1),
  description: z.string().min(1),
  blocking: z.enum(["model_fixable", "contradiction", "unverifiable"]),
}).strict();

export type Gap = z.infer<typeof GapSchema>;

export const VerdictSchema = z.object({
  refuted: z.boolean(),
  gaps: z.array(GapSchema),
}).strict();

export type Verdict = z.infer<typeof VerdictSchema>;

// ──── Aggregated Outcome ────

export type AggregatedOutcome =
  | { type: "achieved"; summary: string }
  | { type: "not_achieved"; gaps: Gap[]; summary: string; fingerprint: string }
  | { type: "blocked"; reason: string };

// ──── Evidence Packet ────

export interface EvidencePacket {
  objective: string;
  changedFiles: string[];
  planFile: string | null;
  finalResponse: string;
  priorGaps: string;
}

// ──── Goal State (serializable snapshot) ────

export interface GoalState {
  id: string;
  objective: string;
  phase: GoalPhase;
  status: GoalStatus;
  plan: Plan | null;
  planPath: string | null;
  verifyRounds: number;
  workerRounds: number;
  lastGaps: Gap[];
  gapFingerprint: string;
  stallStreak: number;
  createdAt: string;
  updatedAt: string;
}

// ──── Runtime Events ────

export type GoalRuntimeEvent =
  | { type: "goal-plan-created"; plan: Plan; planPath: string }
  | { type: "goal-plan-failed"; reason: string }
  | { type: "goal-worker-start"; round: number }
  | { type: "goal-verification-start"; round: number }
  | { type: "goal-verdict"; round: number; outcome: AggregatedOutcome; skepticCount: number }
  | { type: "goal-complete"; summary: string }
  | { type: "goal-failed"; reason: string }
  | { type: "goal-paused"; reason: string }
  | { type: "goal-stalled"; reason: string };

// ──── Planner Input/Output ────

export interface PlannerInput {
  objective: string;
  workspace: string;
}

// ──── Classifier Options ────

export interface ClassifierOptions {
  skepticCount: number;
  workspace: string;
}
