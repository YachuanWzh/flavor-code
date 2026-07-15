import { z } from "zod";

export const LoopStatusSchema = z.enum([
  "running", "succeeded", "failed", "blocked", "cancelled",
  "budget_exhausted", "no_progress", "needs_human",
]);

export const LoopApprovalSchema = z.object({
  dimension: z.enum(["cycles", "tokens"]),
  previousCheckpoint: z.number().int().nonnegative(),
  newCheckpoint: z.number().int().positive(),
  usage: z.number().int().nonnegative(),
  approvedAt: z.string().datetime({ offset: true }),
}).strict();

export const LoopVerificationCommandSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()),
  exitCode: z.number().int().nullable(),
  stdout: z.string(),
  stderr: z.string(),
  truncated: z.boolean(),
}).strict();

export const LoopVerificationEvidenceSchema = z.object({
  passed: z.boolean(),
  commands: z.array(LoopVerificationCommandSchema),
  summary: z.string(),
}).strict();

export const LoopCycleEvidenceSchema = z.object({
  cycle: z.number().int().positive(),
  startedAt: z.string().datetime({ offset: true }),
  completedAt: z.string().datetime({ offset: true }),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  workspaceFingerprint: z.string(),
  verification: LoopVerificationEvidenceSchema,
}).strict();

export const LoopStateSchema = z.object({
  version: z.literal(1),
  loopId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
  goal: z.string().trim().min(1),
  workspace: z.string().min(1),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
  status: LoopStatusSchema,
  config: z.object({
    cycleStep: z.number().int().positive(),
    tokenStep: z.number().int().positive(),
    isolation: z.literal("auto"),
  }).strict(),
  budget: z.object({
    cyclesUsed: z.number().int().nonnegative(),
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    cycleCheckpoint: z.number().int().positive(),
    tokenCheckpoint: z.number().int().positive(),
    approvals: z.array(LoopApprovalSchema),
  }).strict(),
  cycles: z.array(LoopCycleEvidenceSchema),
  terminalReason: z.string().optional(),
}).strict();

export const LoopEventSchema = z.object({
  version: z.literal(1),
  type: z.enum(["created", "cycle_started", "cycle_completed", "verification", "budget_approved", "terminal"]),
  timestamp: z.string().datetime({ offset: true }),
  loopId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
  payload: z.record(z.string(), z.unknown()),
}).strict();

export type LoopStatus = z.infer<typeof LoopStatusSchema>;
export type LoopApproval = z.infer<typeof LoopApprovalSchema>;
export type LoopVerificationEvidence = z.infer<typeof LoopVerificationEvidenceSchema>;
export type LoopCycleEvidence = z.infer<typeof LoopCycleEvidenceSchema>;
export type LoopState = z.infer<typeof LoopStateSchema>;
export type LoopEvent = z.infer<typeof LoopEventSchema>;
