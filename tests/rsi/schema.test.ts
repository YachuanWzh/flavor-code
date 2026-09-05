import { describe, expect, it } from "vitest";
import { RsiConfigSchema } from "../../src/rsi/config.js";
import { FlavorConfigSchema } from "../../src/config/schema.js";

describe("RSI configuration defaults (P0-01 / E1)", () => {
  it("does not grant auto-promotion authority by default", () => {
    const config = RsiConfigSchema.parse({});
    expect(config.mode).toBe("observe");
    expect(config.scope).toBe("project");
    expect(config.allowedKinds).toEqual(["prompt_rule", "skill"]);
    expect(config.autoPromoteMaxRisk).toBeNull();
    expect(config.promotionContract).toBe("r1-quality-v1");
  });

  it("rejects unknown fields and invalid budgets", () => {
    expect(RsiConfigSchema.safeParse({ bypassGrader: true }).success).toBe(false);
    expect(RsiConfigSchema.safeParse({ dailyMaxTokens: 0 }).success).toBe(false);
    expect(RsiConfigSchema.safeParse({ mode: "yolo" }).success).toBe(false);
    expect(RsiConfigSchema.safeParse({ allowedKinds: ["shell_everything"] }).success).toBe(false);
  });

  it("caps the auto-promotion ceiling at R1/R2 tiers only", () => {
    expect(RsiConfigSchema.safeParse({ autoPromoteMaxRisk: "R1" }).success).toBe(true);
    expect(RsiConfigSchema.safeParse({ autoPromoteMaxRisk: "R2" }).success).toBe(true);
    // R3/R4 are never eligible for bounded auto-promotion (rsi.md E1).
    expect(RsiConfigSchema.safeParse({ autoPromoteMaxRisk: "R3" }).success).toBe(false);
    expect(RsiConfigSchema.safeParse({ autoPromoteMaxRisk: "R4" }).success).toBe(false);
    expect(RsiConfigSchema.safeParse({ autoPromoteMaxRisk: "R9" }).success).toBe(false);
  });

  it("keeps existing top-level defaults untouched and adds rsi with defaults", () => {
    const parsed = FlavorConfigSchema.parse({});
    expect(parsed.rsi.mode).toBe("observe");
    // Pre-existing evolve defaults must survive the rsi addition.
    expect(parsed.evolve).toEqual({
      promptTop: 3,
      minRepeats: 2,
      testCommand: "npm test",
      testTimeoutMs: 120_000,
    });
  });

  it("loads an explicit rsi override through the top-level schema", () => {
    const parsed = FlavorConfigSchema.parse({
      rsi: { mode: "assisted", dailyMaxTokens: 10_000 },
    });
    expect(parsed.rsi.mode).toBe("assisted");
    expect(parsed.rsi.dailyMaxTokens).toBe(10_000);
    // Untouched fields keep their safe defaults.
    expect(parsed.rsi.autoPromoteMaxRisk).toBeNull();
  });

  it("rejects unknown nested rsi fields via the top-level schema", () => {
    expect(
      FlavorConfigSchema.safeParse({ rsi: { approveEverything: true } }).success,
    ).toBe(false);
  });
});
