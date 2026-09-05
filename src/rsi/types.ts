/**
 * RSI (recursive self-improvement) protocol types — task P0-01.
 *
 * These are the frozen vocabulary shared by the improvement loop: risk tiers,
 * candidate lifecycle, proposal records, and trusted tool-call terminal
 * events. Pure declarations only — no runtime behaviour lives here, and this
 * module must not import production/UI code (dependency direction:
 * config/types -> policy -> storage/executors -> control-service).
 */

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
