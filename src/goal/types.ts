import { z } from "zod";
import type { AgentEvent } from "../agent/types.js";

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
  contractHash: string;
  workspaceDiffHash: string;
  workspaceStatus: string[];
  hostVerification?: HostVerificationEvidence;
}

export interface HostVerificationEvidence {
  passed: boolean;
  summary: string;
  commands: Array<{
    command: string;
    args: string[];
    exitCode: number | null;
    stdout?: string;
    stderr?: string;
    truncated?: boolean;
  }>;
}

const HostVerificationEvidenceSchema = z.object({
  passed: z.boolean(),
  summary: z.string(),
  commands: z.array(z.object({
    command: z.string(), args: z.array(z.string()), exitCode: z.number().int().nullable(),
    stdout: z.string().optional(), stderr: z.string().optional(), truncated: z.boolean().optional(),
  }).strict()).max(100),
}).strict();

// ──── Goal State (serializable snapshot) ────

export const GoalStateSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
  objective: z.string().min(1),
  phase: GoalPhaseSchema,
  status: GoalStatusSchema,
  plan: PlanSchema.nullable(),
  planPath: z.string().nullable(),
  verifyRounds: z.number().int().min(0),
  workerRounds: z.number().int().min(0),
  /** Worker output checkpoint used to resume verification without rerunning tools. */
  pendingVerification: z.object({
    round: z.number().int().positive(),
    finalResponse: z.string().max(16_000),
  }).strict().nullable().optional(),
  lastGaps: z.array(GapSchema),
  gapFingerprint: z.string(),
  stallStreak: z.number().int().min(0),
  contractHash: z.string().regex(/^[a-f0-9]{64}$/),
  evidenceRounds: z.array(z.object({
    round: z.number().int().positive(),
    workspaceDiffHash: z.string().regex(/^[a-f0-9]{64}$/),
    hostVerification: HostVerificationEvidenceSchema.optional(),
  }).strict()).max(1_000),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
}).strict();

export type GoalState = z.infer<typeof GoalStateSchema>;

// ──── Runtime Events ────

export type GoalRuntimeEvent =
  | { type: "goal-resumed"; goalId: string; round: number }
  | { type: "goal-plan-created"; plan: Plan; planPath: string }
  | { type: "goal-plan-failed"; reason: string }
  | { type: "goal-worker-start"; round: number }
  | { type: "goal-worker-event"; round: number; event: AgentEvent }
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
