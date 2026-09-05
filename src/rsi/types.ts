/**
 * RSI (recursive self-improvement) protocol types — task P0-01.
 *
 * These are the frozen vocabulary shared by the improvement loop: risk tiers,
 * candidate lifecycle, proposal records, trusted tool-call terminal events,
 * request identity, trial terminals, promotion (benefit) contracts, and eval
 * reports. Declarations and declarative Zod schemas only — no runtime
 * behaviour lives here, and this module must not import production/UI code
 * (dependency direction: config/types -> policy -> storage/executors ->
 * control-service).
 */

import { z } from "zod";

export const RSI_MODES = ["off", "observe", "assisted", "bounded_auto"] as const;
export type RsiMode = (typeof RSI_MODES)[number];

export const RSI_CANDIDATE_KINDS = [
  "prompt_rule",
  "skill",
  "adapter",
  "runtime",
  "meta_strategy",
] as const;
export type RsiCandidateKind = (typeof RSI_CANDIDATE_KINDS)[number];

/** Risk tier from rsi.md section 3.2. Behaviour, not file extension, decides it. */
export const RSI_RISK_TIERS = ["R0", "R1", "R2", "R3", "R4"] as const;
export type RsiRiskTier = (typeof RSI_RISK_TIERS)[number];

/** Tiers eligible for bounded auto-promotion at all (rsi.md E1); higher tiers always go manual. */
export const RSI_AUTO_PROMOTABLE_RISKS = ["R1", "R2"] as const;
export type RsiAutoPromotableRisk = (typeof RSI_AUTO_PROMOTABLE_RISKS)[number];

export const RSI_RISK_ORDER: Record<RsiRiskTier, number> = {
  R0: 0,
  R1: 1,
  R2: 2,
  R3: 3,
  R4: 4,
};

/** Scope levels. Widening scope is its own evaluation and never rides a version bump. */
export const RSI_SCOPE_LEVELS = ["project", "global"] as const;
export type RsiScopeLevel = (typeof RSI_SCOPE_LEVELS)[number];

export interface RsiScope {
  level: RsiScopeLevel;
  /** Trusted workspace identity bound by the host, never supplied by the model. */
  workspaceId: string;
}

/**
 * Candidate lifecycle (rsi.md section 6.1). Terminal publication states
 * (`shadow`/`canary`/`stable`) are only reachable through the promotion
 * gate with evidence; `rolled_back` restores a previous stable release.
 */
export const RSI_CANDIDATE_STATUSES = [
  "proposed",
  "building",
  "evaluating",
  "qualified",
  "inconclusive",
  "rejected",
  "shadow",
  "canary",
  "stable",
  "rolled_back",
  "archived",
] as const;
export type RsiCandidateStatus = (typeof RSI_CANDIDATE_STATUSES)[number];

/** A structured improvement hypothesis. Proposals carry no publication power. */
export interface RsiProposal {
  id: string;
  kind: RsiCandidateKind;
  riskTier: RsiRiskTier;
  scope: RsiScope;
  /** Exact stable release the candidate was derived from (null = experiment baseline). */
  baseReleaseId: string | null;
  /** Evolve suggestion/signal ids motivating the hypothesis. */
  sourceSuggestionIds: string[];
  /** Counter-examples the candidate must not regress. */
  counterExamples: string[];
  /** Version of the improver strategy that produced this proposal. */
  improverVersion: string;
  createdAt: string;
}

/**
 * Trusted tool-call terminal states (rsi.md section 7.2 / E2). Events are
 * produced by the host execution layer only; candidates must never self-report.
 */
export const RSI_TOOL_OUTCOMES = ["success", "failure", "cancelled"] as const;
export type RsiToolOutcome = (typeof RSI_TOOL_OUTCOMES)[number];

export interface RsiToolTerminal {
  sessionId: string;
  /** Host-generated run id; never taken from candidate input. */
  runId: string;
  /** Host-generated per-call id used as the aggregation denominator key. */
  toolCallId: string;
  tool: string;
  outcome: RsiToolOutcome;
}

/** Verdict shape returned by pure policy functions in `policy.ts`. */
export type PolicyVerdict = { ok: true } | { ok: false; reason: string };

export function riskAtOrBelow(tier: RsiRiskTier, max: RsiRiskTier): boolean {
  return RSI_RISK_ORDER[tier] <= RSI_RISK_ORDER[max];
}

/** Trusted caller role in front of the control service (rsi.md 11.3). */
export const RSI_CONTROL_ROLES = ["governor", "runner", "observer", "candidate"] as const;
export type RsiControlRole = (typeof RSI_CONTROL_ROLES)[number];

/** Closed vocabulary of mutating control requests (P0-03c protocol). */
export const RSI_CONTROL_REQUEST_KINDS = [
  "budget.reserve",
  "budget.settle",
  "trial.report",
  "artifact.freeze",
  "candidate.propose",
  "eval.register",
  "promotion.prepare",
  "promotion.commit",
  "rollback.start",
  "rollback.complete",
  "pause",
  "reconcile.report",
  "reconcile.close",
] as const;
export type RsiControlRequestKind = (typeof RSI_CONTROL_REQUEST_KINDS)[number];

/**
 * Request identity bound to a control token by the trusted host. Candidates
 * must never obtain a token with mutating authority (rsi.md 11.3/11.4).
 */
export const RsiRequestIdentitySchema = z
  .object({
    schemaVersion: z.literal(1),
    role: z.enum(RSI_CONTROL_ROLES),
    /** Stable id of the control client the token was minted for. */
    clientId: z.string().min(1),
    /** Trusted workspace binding; never taken from candidate input. */
    workspaceId: z.string().min(1),
    sessionId: z.string().min(1).nullable(),
  })
  .strict();
export type RsiRequestIdentity = z.infer<typeof RsiRequestIdentitySchema>;

/**
 * Trial terminal states (rsi.md 7.2/7.5, E6). Every admitted job must end in
 * exactly one of these — no silent drops. `runner_unavailable` means the job
 * never started (never charged as candidate failure); `infrastructure_invalid`
 * marks a paired-side failure per the evaluation rules.
 */
export const RSI_TRIAL_OUTCOMES = [
  "passed",
  "failed",
  "timed_out",
  "crashed",
  "cancelled",
  "runner_unavailable",
  "infrastructure_invalid",
] as const;
export type RsiTrialOutcome = (typeof RSI_TRIAL_OUTCOMES)[number];

const Sha256Hex = z.string().regex(/^[a-f0-9]{64}$/);

/** Per-scope usage under the billing caliber; `costUnknown` keeps honest accounting. */
export const RsiTrialUsageSchema = z
  .object({
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    cachedReadTokens: z.number().int().nonnegative(),
    cachedWriteTokens: z.number().int().nonnegative(),
    computeMs: z.number().int().nonnegative(),
    /** True when proxy/provider accounting could not confirm cost. */
    costUnknown: z.boolean(),
  })
  .strict();
export type RsiTrialUsage = z.infer<typeof RsiTrialUsageSchema>;

export const RsiTrialTerminalSchema = z
  .object({
    schemaVersion: z.literal(1),
    jobId: z.string().min(1),
    campaignId: z.string().min(1),
    candidateId: z.string().min(1),
    caseId: z.string().min(1),
    artifactHash: Sha256Hex,
    outcome: z.enum(RSI_TRIAL_OUTCOMES),
    /** E6: proof the job actually stopped (exit observed, tree probe, ...). */
    stopEvidence: z.string().min(1),
    usage: RsiTrialUsageSchema,
    startedAt: z.string().datetime({ offset: true }),
    endedAt: z.string().datetime({ offset: true }),
    /** Terminal events come from the trusted execution layer only. */
    reporter: RsiRequestIdentitySchema,
    evidenceRefs: z.array(z.string().min(1)),
  })
  .strict()
  .superRefine((trial, ctx) => {
    if (trial.reporter.role !== "runner" && trial.reporter.role !== "governor") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["reporter", "role"],
        message: "trial terminals must be reported by the trusted execution layer (runner/governor), never self-reported by candidates",
      });
    }
  });
export type RsiTrialTerminal = z.infer<typeof RsiTrialTerminalSchema>;

/** Benefit paths from rsi.md 7.3; chosen at proposal time, never after results. */
export const RSI_CONTRACT_PATHS = ["quality", "efficiency", "defect_fix"] as const;
export type RsiContractPath = (typeof RSI_CONTRACT_PATHS)[number];

/** Metric caliber enums; every primary metric must state all three (P0-01 acceptance). */
export const RSI_METRIC_DENOMINATORS = ["valid_tasks", "exposure_tasks", "settled_calls", "success_tasks"] as const;
export const RSI_METRIC_MISSING_POLICIES = ["n_a", "fail", "conservative_charge"] as const;
export const RSI_METRIC_TIMEOUT_POLICIES = ["failure", "infrastructure_invalid", "n_a"] as const;

export const RsiContractMetricSchema = z
  .object({
    name: z.string().min(1),
    role: z.enum(["primary", "constraint"]),
    direction: z.enum(["increase", "decrease"]),
    denominator: z.enum(RSI_METRIC_DENOMINATORS),
    missingValue: z.enum(RSI_METRIC_MISSING_POLICIES),
    timeoutPolicy: z.enum(RSI_METRIC_TIMEOUT_POLICIES),
  })
  .strict();
export type RsiContractMetric = z.infer<typeof RsiContractMetricSchema>;

const REQUIRED_THRESHOLDS: Record<RsiContractPath, readonly string[]> = {
  quality: [
    "minTsrAbsGainPoints",
    "pairedCiLowerBoundGt",
    "globalTsrNonInferiorityFloor",
    "costRatioUpperBound",
    "p95LatencyRatioUpperBound",
  ],
  efficiency: ["minCostReduction", "costRatioCiUpperBound", "tsrNonInferiorityFloor"],
  defect_fix: ["minRelativeDefectReduction", "baselineDefectRate"],
};

/**
 * Frozen promotion (benefit) contract: pre-registered path, per-path numeric
 * thresholds, fixed attempt counts, and every metric with denominator,
 * missing-value and timeout caliber. Reading results never rewrites the
 * contract.
 */
export const RsiPromotionContractSchema = z
  .object({
    schemaVersion: z.literal(1),
    contractId: z.string().min(1),
    path: z.enum(RSI_CONTRACT_PATHS),
    /** 7.5 rule 3: fixed trials per task per version, not "until it passes". */
    maxTrialsPerTask: z.number().int().positive(),
    metrics: z.array(RsiContractMetricSchema).min(1),
    thresholds: z.record(z.string(), z.number().finite()),
  })
  .strict()
  .superRefine((contract, ctx) => {
    if (!contract.metrics.some((metric) => metric.role === "primary")) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["metrics"], message: "a promotion contract needs at least one primary metric" });
    }
    for (const key of REQUIRED_THRESHOLDS[contract.path]) {
      if (typeof contract.thresholds[key] !== "number") {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["thresholds", key], message: `path "${contract.path}" requires numeric threshold "${key}" pre-registered before results` });
      }
    }
    if (contract.path === "defect_fix" && contract.thresholds.baselineDefectRate === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["thresholds", "baselineDefectRate"], message: "baseline defect rate is zero, so relative reduction is undefined — register a coverage or absolute-difference contract before the experiment" });
    }
  });
export type RsiPromotionContract = z.infer<typeof RsiPromotionContractSchema>;

/** Candidate record shape from rsi.md 11.2 (control-layer view; risk/scope decided by trusted review). */
export const RsiCandidateSchema = z
  .object({
    schemaVersion: z.literal(1),
    candidateId: z.string().min(1),
    campaignId: z.string().min(1),
    parentReleaseIds: z.array(z.string().min(1)),
    proposerReleaseId: z.string().min(1),
    kind: z.enum(RSI_CANDIDATE_KINDS),
    risk: z.enum(RSI_RISK_TIERS),
    hypothesis: z
      .object({
        problem: z.string().min(1),
        mechanism: z.string().min(1),
        expectedBenefit: z.string().min(1),
        sourceIds: z.array(z.string().min(1)),
        counterexampleCaseIds: z.array(z.string().min(1)),
      })
      .strict(),
    scope: z
      .object({
        workspaceIds: z.array(z.string().min(1)).min(1),
        platforms: z.array(z.string().min(1)).min(1),
        taskFamilies: z.array(z.string().min(1)).min(1),
        expiresAt: z.string().datetime({ offset: true }).optional(),
      })
      .strict(),
    artifact: z
      .object({
        sha256: Sha256Hex,
        manifestRef: z.string().min(1),
        runtimeMode: z.literal("isolated"),
        stateSchemaVersion: z.number().int().positive(),
      })
      .strict(),
    contractRef: z.string().min(1),
    lifecycle: z.enum(RSI_CANDIDATE_STATUSES),
    revision: z.number().int().positive(),
  })
  .strict();
export type RsiCandidate = z.infer<typeof RsiCandidateSchema>;

/**
 * Eval report identity (rsi.md 11.1): a report is bound to the exact
 * candidate/baseline/suite/grader hashes it was produced against, so an old
 * report can never certify new content (P0-04 acceptance).
 */
export const RsiEvalReportSchema = z
  .object({
    schemaVersion: z.literal(1),
    reportId: z.string().min(1),
    candidateHash: Sha256Hex,
    baselineHash: Sha256Hex,
    suiteHash: Sha256Hex,
    graderHash: Sha256Hex,
    environmentFingerprint: z.string().min(1),
    contractId: z.string().min(1),
    decision: z.enum(["passed", "failed", "inconclusive"]),
    trialTerminals: z.array(RsiTrialTerminalSchema).min(1),
    createdAt: z.string().datetime({ offset: true }),
  })
  .strict();
export type RsiEvalReport = z.infer<typeof RsiEvalReportSchema>;
