/**
 * RSI pure policy checks — task P0-01 (rsi.md sections 3.2/5/11, E1).
 *
 * These functions are side-effect free: no file access, no model calls, no
 * runtime imports. They encode "config parsing success != authority granted":
 * even a valid `bounded_auto` config cannot auto-promote without a control
 * layer authorization handle issued outside this process.
 */

import type { RsiConfig } from "./config.js";
import {
  riskAtOrBelow,
  type PolicyVerdict,
  type RsiCandidateKind,
  type RsiRiskTier,
  type RsiScopeLevel,
} from "./types.js";

const DENY: PolicyVerdict = { ok: false, reason: "rsi mode is off" };

export interface ProposalScopeRequest {
  kind: RsiCandidateKind;
  riskTier: RsiRiskTier;
  scopeLevel: RsiScopeLevel;
}

/**
 * Whether a proposal may be *created as a candidate* under the config.
 * R3/R4 behaviour is never activated through this path — R3 goes through the
 * manual maintainer flow and R4 accepts suggestions only, so both are denied
 * here as candidate scopes for the automated pipeline.
 */
export function checkProposalScope(
  config: RsiConfig,
  request: ProposalScopeRequest,
): PolicyVerdict {
  if (config.mode === "off") return DENY;
  if (!config.allowedKinds.includes(request.kind)) {
    return { ok: false, reason: `kind "${request.kind}" is not in allowedKinds` };
  }
  if (request.scopeLevel !== config.scope) {
    return {
      ok: false,
      reason: `scope "${request.scopeLevel}" exceeds configured scope "${config.scope}"; scope widening needs its own evaluation`,
    };
  }
  if (request.riskTier === "R3" || request.riskTier === "R4") {
    return {
      ok: false,
      reason: `${request.riskTier} changes are never applied through the automated candidate path (manual maintainer flow only)`,
    };
  }
  return { ok: true };
}

/** Authorization handle minted by the trusted control layer, never by config or the model. */
export interface PromotionAuthorization {
  issuedBy: string;
  contractId: string;
}

export interface PromotionAuthorityRequest {
  kind: RsiCandidateKind;
  riskTier: RsiRiskTier;
  /** Frozen contract id the evaluation report was produced under. */
  contractId: string;
  /** Control-layer grant; absence means no auto-promotion, full stop. */
  authorization: PromotionAuthorization | undefined;
}

/**
 * Whether a candidate may be *auto-promoted* (bounded_auto). Manual assisted
 * publication is a separate gate; this function only models the automatic
 * authority path.
 */
export function checkPromotionAuthority(
  config: RsiConfig,
  request: PromotionAuthorityRequest,
): PolicyVerdict {
  if (config.mode !== "bounded_auto") {
    return { ok: false, reason: `auto-promotion requires bounded_auto mode (current: "${config.mode}")` };
  }
  if (config.autoPromoteMaxRisk === null) {
    return { ok: false, reason: "autoPromoteMaxRisk is unset; no risk tier is authorized" };
  }
  const max = config.autoPromoteMaxRisk;
  if (!riskAtOrBelow(request.riskTier, max)) {
    return {
      ok: false,
      reason: `risk ${request.riskTier} exceeds autoPromoteMaxRisk ${max}`,
    };
  }
  if (!config.allowedKinds.includes(request.kind)) {
    return { ok: false, reason: `kind "${request.kind}" is not in allowedKinds` };
  }
  if (request.contractId !== config.promotionContract) {
    return {
      ok: false,
      reason: `evaluation report contract "${request.contractId}" does not match frozen promotionContract "${config.promotionContract}"`,
    };
  }
  if (request.authorization === undefined) {
    return { ok: false, reason: "no control-layer authorization handle; config alone never grants promotion authority" };
  }
  if (request.authorization.contractId !== config.promotionContract) {
    return {
      ok: false,
      reason: `authorization contract "${request.authorization.contractId}" does not match frozen promotionContract "${config.promotionContract}"`,
    };
  }
  return { ok: true };
}
