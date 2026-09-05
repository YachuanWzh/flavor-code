import { describe, expect, it } from "vitest";
import { RsiConfigSchema, type RsiConfig } from "../../src/rsi/config.js";
import { checkPromotionAuthority, checkProposalScope } from "../../src/rsi/policy.js";

const defaults: RsiConfig = RsiConfigSchema.parse({});

function withConfig(overrides: Partial<RsiConfig>): RsiConfig {
  return { ...defaults, ...overrides };
}

describe("checkProposalScope (P0-01)", () => {
  it("denies everything while mode is off", () => {
    const verdict = checkProposalScope(withConfig({ mode: "off" }), {
      kind: "prompt_rule",
      riskTier: "R1",
      scopeLevel: "project",
    });
    expect(verdict).toEqual({ ok: false, reason: "rsi mode is off" });
  });

  it("allows default kinds at project scope in observe/assisted modes", () => {
    for (const mode of ["observe", "assisted", "bounded_auto"] as const) {
      expect(
        checkProposalScope(withConfig({ mode }), {
          kind: "prompt_rule",
          riskTier: "R1",
          scopeLevel: "project",
        }),
      ).toEqual({ ok: true });
    }
  });

  it("rejects kinds outside allowedKinds", () => {
    const verdict = checkProposalScope(defaults, {
      kind: "runtime",
      riskTier: "R2",
      scopeLevel: "project",
    });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toContain("runtime");
  });

  it("rejects scope widening beyond the configured level", () => {
    const verdict = checkProposalScope(defaults, {
      kind: "prompt_rule",
      riskTier: "R1",
      scopeLevel: "global",
    });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toContain("scope");
  });

  it("never routes R3/R4 activation through the candidate path", () => {
    const wide = withConfig({ allowedKinds: ["runtime", "meta_strategy"] });
    for (const tier of ["R3", "R4"] as const) {
      const verdict = checkProposalScope(wide, {
        kind: "runtime",
        riskTier: tier,
        scopeLevel: "project",
      });
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) expect(verdict.reason).toContain(tier);
    }
  });
});

describe("checkPromotionAuthority (P0-01 / E1)", () => {
  const grant = { issuedBy: "governor", contractId: "r1-quality-v1" };

  it("denies auto-promotion in every non-bounded_auto mode", () => {
    for (const mode of ["off", "observe", "assisted"] as const) {
      const verdict = checkPromotionAuthority(
        withConfig({ mode, autoPromoteMaxRisk: "R1" }),
        { kind: "prompt_rule", riskTier: "R1", contractId: "r1-quality-v1", authorization: grant },
      );
      expect(verdict.ok).toBe(false);
    }
  });

  it("denies when no risk tier ceiling is configured", () => {
    const verdict = checkPromotionAuthority(
      withConfig({ mode: "bounded_auto" }),
      { kind: "prompt_rule", riskTier: "R1", contractId: "r1-quality-v1", authorization: grant },
    );
    expect(verdict).toEqual({
      ok: false,
      reason: "autoPromoteMaxRisk is unset; no risk tier is authorized",
    });
  });

  it("denies risk above the configured ceiling", () => {
    const verdict = checkPromotionAuthority(
      withConfig({ mode: "bounded_auto", autoPromoteMaxRisk: "R1" }),
      { kind: "prompt_rule", riskTier: "R2", contractId: "r1-quality-v1", authorization: grant },
    );
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toContain("exceeds");
  });

  it("a bounded_auto config line alone never grants authority (E1 requirement)", () => {
    const verdict = checkPromotionAuthority(
      withConfig({ mode: "bounded_auto", autoPromoteMaxRisk: "R1" }),
      { kind: "prompt_rule", riskTier: "R1", contractId: "r1-quality-v1", authorization: undefined },
    );
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toContain("authorization");
  });

  it("denies when the grant was minted under a different frozen contract", () => {
    const verdict = checkPromotionAuthority(
      withConfig({ mode: "bounded_auto", autoPromoteMaxRisk: "R1" }),
      { kind: "prompt_rule", riskTier: "R1", contractId: "r1-quality-v1", authorization: { issuedBy: "x", contractId: "other-v9" } },
    );
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toContain("contract");
  });

  it("denies when the evaluation report was produced under a different contract", () => {
    const verdict = checkPromotionAuthority(
      withConfig({ mode: "bounded_auto", autoPromoteMaxRisk: "R1" }),
      { kind: "prompt_rule", riskTier: "R1", contractId: "r1-quality-v0", authorization: grant },
    );
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toContain("report contract");
  });

  it("allows only with mode, ceiling, kind, and control-layer grant all aligned", () => {
    expect(
      checkPromotionAuthority(
        withConfig({ mode: "bounded_auto", autoPromoteMaxRisk: "R1" }),
        { kind: "prompt_rule", riskTier: "R1", contractId: "r1-quality-v1", authorization: grant },
      ),
    ).toEqual({ ok: true });
  });
});
