/**
 * Trusted tool-call outcome aggregation — task P0-02b (rsi.md section 20.6 / E2).
 *
 * Fixes the "pseudo verified" denominator problem: failure rates are computed
 * per unique terminal event keyed by (sessionId, runId, toolCallId), so a
 * quiet run can no longer look healthier than a busy one. Duplicate terminal
 * notifications count once; a conflicting second terminal keeps the first
 * entry and marks the episode's evidence incomplete — the collector must
 * never pick whichever outcome is friendlier to a candidate.
 *
 * This is the pure aggregation core. Production wiring (ToolRuntime bypass,
 * persistence, per-session memory caps) lands with P0-02c; events must come
 * from the trusted execution layer, never from candidate self-reports.
 */

import type { RsiToolTerminal } from "./types.js";

export type RecordResult = "added" | "duplicate" | "conflict";

export interface OutcomeSnapshot {
  success: number;
  failure: number;
  cancelled: number;
  /** Denominator for failureRate: explicit cancellations are excluded and reported separately. */
  comparableCalls: number;
  /** null when there were no comparable calls — UI shows N/A, never 0%. */
  failureRate: number | null;
  /** Calls that received conflicting terminal events (e.g. success then failure). */
  conflicts: number;
  /** False once any conflict occurred; blocks automatic promotion of the episode. */
  evidenceComplete: boolean;
}

function eventKey(event: RsiToolTerminal): string {
  return JSON.stringify([event.sessionId, event.runId, event.toolCallId]);
}

export class ToolOutcomeCollector {
  readonly #terminals = new Map<string, RsiToolTerminal>();
  #conflicts = 0;

  record(event: RsiToolTerminal): RecordResult {
    const prior = this.#terminals.get(eventKey(event));
    if (prior !== undefined) {
      if (prior.tool === event.tool && prior.outcome === event.outcome) {
        return "duplicate";
      }
      // Conflicting terminal states: keep the first recording, flag the
      // episode. Do not throw — an observer fault must not change the tool's
      // own result, it only invalidates this evidence for gating.
      this.#conflicts += 1;
      return "conflict";
    }
    this.#terminals.set(eventKey(event), { ...event });
    return "added";
  }

  snapshot(): OutcomeSnapshot {
    let success = 0;
    let failure = 0;
    let cancelled = 0;
    for (const event of this.#terminals.values()) {
      if (event.outcome === "success") success += 1;
      else if (event.outcome === "failure") failure += 1;
      else cancelled += 1;
    }
    const comparableCalls = success + failure;
    return {
      success,
      failure,
      cancelled,
      comparableCalls,
      failureRate: comparableCalls === 0 ? null : failure / comparableCalls,
      conflicts: this.#conflicts,
      evidenceComplete: this.#conflicts === 0,
    };
  }

  /** End of episode: return the final snapshot and release in-memory events. */
  finalize(): OutcomeSnapshot {
    const snapshot = this.snapshot();
    this.#terminals.clear();
    this.#conflicts = 0;
    return snapshot;
  }
}
