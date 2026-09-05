import { describe, expect, it } from "vitest";

import {
  RsiCandidateSchema,
  RsiEvalReportSchema,
  RsiPromotionContractSchema,
  RsiRequestIdentitySchema,
  RsiTrialTerminalSchema,
} from "../../src/rsi/types.js";
import { checkRequestAuthority } from "../../src/rsi/policy.js";

const HEX = "a".repeat(64);

const identity = {
  schemaVersion: 1 as const,
  role: "runner" as const,
  clientId: "runner-7",
  workspaceId: "ws-1",
  sessionId: null,
};

function baseTrial(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    jobId: "job-1",
    campaignId: "camp-1",
    candidateId: "cand-1",
    caseId: "case-1",
    artifactHash: HEX,
    outcome: "passed",
    stopEvidence: "pid 4242 exited; process-tree probe returned ESRCH",
    usage: { inputTokens: 120, outputTokens: 340, cachedReadTokens: 0, cachedWriteTokens: 0, computeMs: 5000, costUnknown: false },
    startedAt: "2026-09-05T10:00:00Z",
    endedAt: "2026-09-05T10:01:00Z",
    reporter: identity,
    evidenceRefs: ["log:sha256:1"],
    ...overrides,
  };
}

function baseContract(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    contractId: "r1-quality-v1",
    path: "quality",
    maxTrialsPerTask: 3,
    metrics: [
      {
        name: "tsr",
        role: "primary",
        direction: "increase",
        denominator: "valid_tasks",
        missingValue: "fail",
        timeoutPolicy: "failure",
      },
      {
        name: "cost_per_success",
        role: "constraint",
        direction: "decrease",
        denominator: "success_tasks",
        missingValue: "conservative_charge",
        timeoutPolicy: "failure",
      },
    ],
    thresholds: {
      minTsrAbsGainPoints: 5,
      pairedCiLowerBoundGt: 0,
      globalTsrNonInferiorityFloor: -2,
      costRatioUpperBound: 1.1,
      p95LatencyRatioUpperBound: 1.15,
    },
    ...overrides,
  };
}

describe("P0-01 request identity (rsi.md 11.3)", () => {
  it("accepts a fully specified identity and rejects unknown fields", () => {
    expect(RsiRequestIdentitySchema.parse(identity).role).toBe("runner");
    expect(() => RsiRequestIdentitySchema.parse({ ...identity, evil: true })).toThrow();
    expect(() => RsiRequestIdentitySchema.parse({ ...identity, role: "superuser" })).toThrow();
    expect(() => RsiRequestIdentitySchema.parse({ role: "runner", clientId: "x" })).toThrow();
  });

  it("role matrix: candidates never hold control authority, runners only report", () => {
    expect(checkRequestAuthority({ role: "candidate" }, "promotion.commit")).toMatchObject({ ok: false });
    expect(checkRequestAuthority({ role: "candidate" }, "promotion.prepare")).toMatchObject({ ok: false });
    expect(checkRequestAuthority({ role: "candidate" }, "budget.settle")).toMatchObject({ ok: false });
    expect(checkRequestAuthority({ role: "observer" }, "trial.report")).toMatchObject({ ok: false });
    expect(checkRequestAuthority({ role: "observer" }, "reconcile.report")).toMatchObject({ ok: true });
    expect(checkRequestAuthority({ role: "runner" }, "budget.settle")).toMatchObject({ ok: true });
    expect(checkRequestAuthority({ role: "runner" }, "promotion.commit")).toMatchObject({ ok: false });
    expect(checkRequestAuthority({ role: "governor" }, "rollback.start")).toMatchObject({ ok: true });
  });
});

describe("P0-01 trial terminal contract (rsi.md 7.2/7.5, E6)", () => {
  it("accepts a complete terminal with stop evidence and per-scope usage", () => {
    expect(RsiTrialTerminalSchema.parse(baseTrial()).outcome).toBe("passed");
  });

  it("rejects unknown outcomes, missing stop evidence, self-reported candidates, and negative usage", () => {
    expect(() => RsiTrialTerminalSchema.parse(baseTrial({ outcome: "vibes_good" }))).toThrow();
    expect(() => RsiTrialTerminalSchema.parse(baseTrial({ stopEvidence: "" }))).toThrow();
    expect(() => RsiTrialTerminalSchema.parse(baseTrial({ reporter: { ...identity, role: "candidate" } }))).toThrow();
    expect(() => RsiTrialTerminalSchema.parse(baseTrial({ reporter: { ...identity, role: "observer" } }))).toThrow();
    expect(() => RsiTrialTerminalSchema.parse(baseTrial({ usage: { ...baseTrial().usage, inputTokens: -1 } }))).toThrow();
    expect(() => RsiTrialTerminalSchema.parse(baseTrial({ artifactHash: "not-a-hash" }))).toThrow();
    expect(() => RsiTrialTerminalSchema.parse(baseTrial({ smuggledField: 1 }))).toThrow();
    // costUnknown keeps honest accounting: usage must still be shaped, and the
    // terminal itself never fabricates zero cost.
    expect(() => RsiTrialTerminalSchema.parse(baseTrial({ usage: undefined }))).toThrow();
  });
});

describe("P0-01 promotion contract (rsi.md 7.3)", () => {
  it("accepts a pre-registered quality contract with full metric caliber", () => {
    expect(RsiPromotionContractSchema.parse(baseContract()).path).toBe("quality");
  });

  it("every primary metric must carry denominator, missing-value and timeout caliber", () => {
    const noCaliber = structuredClone(baseContract()) as { metrics: Record<string, unknown>[] };
    noCaliber.metrics = [{ name: "tsr", role: "primary", direction: "increase" }];
    expect(() => RsiPromotionContractSchema.parse(noCaliber)).toThrow();
    expect(() => RsiPromotionContractSchema.parse({ ...baseContract(), metrics: [] })).toThrow();
  });

  it("quality path requires the documented threshold set", () => {
    for (const key of ["minTsrAbsGainPoints", "globalTsrNonInferiorityFloor", "costRatioUpperBound", "p95LatencyRatioUpperBound"]) {
      const bad = structuredClone(baseContract()) as { thresholds: Record<string, unknown> };
      delete bad.thresholds[key];
      expect(() => RsiPromotionContractSchema.parse(bad)).toThrow();
    }
  });

  it("defect_fix path refuses a zero baseline rate (relative reduction undefined)", () => {
    expect(() =>
      RsiPromotionContractSchema.parse(baseContract({
        contractId: "r1-defect-v1",
        path: "defect_fix",
        thresholds: { minRelativeDefectReduction: 0.3, baselineDefectRate: 0 },
      })),
    ).toThrow(/zero|undefined/i);
    expect(() =>
      RsiPromotionContractSchema.parse(baseContract({
        contractId: "r1-defect-v1",
        path: "defect_fix",
        thresholds: { minRelativeDefectReduction: 0.3, baselineDefectRate: 0.12 },
      })).path,
    ).toBeTruthy();
  });

  it("efficiency path enforces its own thresholds and rejects unknown paths", () => {
    expect(() => RsiPromotionContractSchema.parse(baseContract({ path: "vibes" }))).toThrow();
    expect(() =>
      RsiPromotionContractSchema.parse(baseContract({ path: "efficiency", thresholds: { minCostReduction: 0.1 } })),
    ).toThrow();
    expect(
      RsiPromotionContractSchema.parse(baseContract({
        path: "efficiency",
        thresholds: { minCostReduction: 0.1, costRatioCiUpperBound: 0.9, tsrNonInferiorityFloor: -0.02 },
      })).path,
    ).toBe("efficiency");
  });
});

describe("P0-01 candidate and eval report records (rsi.md 11.1/11.2)", () => {
  const candidate = {
    schemaVersion: 1,
    candidateId: "cand-1",
    campaignId: "camp-1",
    parentReleaseIds: ["rel-0"],
    proposerReleaseId: "rel-0",
    kind: "prompt_rule",
    risk: "R1",
    hypothesis: {
      problem: "path guessing fails on Windows",
      mechanism: "prefer glob lookup before read",
      expectedBenefit: "+5pt TSR on path family",
      sourceIds: ["sig-1"],
      counterexampleCaseIds: ["case-neg-1"],
    },
    scope: { workspaceIds: ["ws-1"], platforms: ["win32"], taskFamilies: ["paths"] },
    artifact: { sha256: HEX, manifestRef: `artifacts/${HEX}`, runtimeMode: "isolated", stateSchemaVersion: 1 },
    contractRef: "r1-quality-v1",
    lifecycle: "proposed",
    revision: 1,
  };

  it("accepts the 11.2 shape and rejects non-isolated runtime or open status words", () => {
    expect(RsiCandidateSchema.parse(candidate).candidateId).toBe("cand-1");
    expect(() =>
      RsiCandidateSchema.parse({ ...candidate, artifact: { ...candidate.artifact, runtimeMode: "in-process" } }),
    ).toThrow();
    expect(() => RsiCandidateSchema.parse({ ...candidate, lifecycle: "ship_it" })).toThrow();
    expect(() => RsiCandidateSchema.parse({ ...candidate, smuggled: 1 })).toThrow();
  });

  it("eval report binds candidate/baseline/suite/grader hashes and decision", () => {
    const report = {
      schemaVersion: 1,
      reportId: "rep-1",
      candidateHash: HEX,
      baselineHash: "b".repeat(64),
      suiteHash: "c".repeat(64),
      graderHash: "d".repeat(64),
      environmentFingerprint: "env-win11-node24",
      contractId: "r1-quality-v1",
      decision: "inconclusive",
      trialTerminals: [baseTrial(), baseTrial({ jobId: "job-2", outcome: "timed_out" })],
      createdAt: "2026-09-05T12:00:00Z",
    };
    expect(RsiEvalReportSchema.parse(report).decision).toBe("inconclusive");
    expect(() => RsiEvalReportSchema.parse({ ...report, decision: "almost" })).toThrow();
    expect(() => RsiEvalReportSchema.parse({ ...report, trialTerminals: [] })).toThrow();
  });
});
