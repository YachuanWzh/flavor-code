import { describe, expect, it } from "vitest";
import { formatUsageSummary, parseUsageEntries, summarizeUsage } from "../../src/utils/usage-summary.js";

function line(partial: Record<string, unknown>): string {
  return JSON.stringify({ event: "flavor-usage", provider: "anthropic", model: "example", sessionId: "session-a", ...partial });
}

describe("parseUsageEntries", () => {
  it("returns an empty list for empty input", () => {
    expect(parseUsageEntries("")).toEqual([]);
    expect(parseUsageEntries("   \n  ")).toEqual([]);
  });

  it("parses valid flavor-usage lines", () => {
    const entries = parseUsageEntries(line({ inputTokens: 5, cacheReadTokens: 3 }));
    expect(entries).toHaveLength(1);
    expect(entries[0]?.inputTokens).toBe(5);
    expect(entries[0]?.cacheReadTokens).toBe(3);
  });

  it("skips malformed lines and unrelated events", () => {
    const raw = [
      "not json at all",
      JSON.stringify({ event: "something-else", model: "x" }),
      line({ inputTokens: 1 }),
    ].join("\n");
    const entries = parseUsageEntries(raw);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.inputTokens).toBe(1);
  });
});

describe("summarizeUsage", () => {
  it("reports zero requests for an empty entry list", () => {
    const summary = summarizeUsage([]);
    expect(summary.requests).toBe(0);
    expect(summary.byModel).toEqual([]);
    expect(summary.totalInputTokens).toBe(0);
    expect(summary.cacheShare).toBe(0);
  });

  it("groups by provider and model and aggregates totals", () => {
    const entries = parseUsageEntries([
      line({ model: "alpha", inputTokens: 10, cacheReadTokens: 90, cacheCreationTokens: 20, totalInputTokens: 120, cacheHitRatio: 0.75 }),
      line({ model: "alpha", inputTokens: 5, cacheReadTokens: 95, cacheCreationTokens: 0, totalInputTokens: 100, cacheHitRatio: 0.95 }),
      line({ provider: "openai", model: "beta", inputTokens: 8, cacheReadTokens: 72, cacheCreationTokens: 0, totalInputTokens: 80, cacheHitRatio: 0.9 }),
    ].join("\n"));

    const summary = summarizeUsage(entries);
    expect(summary.requests).toBe(3);
    expect(summary.sessionId).toBe("session-a");
    expect(summary.byModel).toHaveLength(2);

    const alpha = summary.byModel.find((stats) => stats.model === "alpha");
    expect(alpha).toMatchObject({
      provider: "anthropic",
      requests: 2,
      inputTokens: 15,
      cacheReadTokens: 185,
      cacheCreationTokens: 20,
      totalInputTokens: 220,
      minHitRatio: 0.75,
    });
    // Average of 0.75 and 0.95.
    expect(alpha?.averageHitRatio).toBeCloseTo(0.85, 5);

    const beta = summary.byModel.find((stats) => stats.model === "beta");
    expect(beta?.provider).toBe("openai");
    expect(beta?.requests).toBe(1);

    expect(summary.totalInputTokens).toBe(300);
    expect(summary.totalCacheReadTokens).toBe(257);
    expect(summary.cacheShare).toBeCloseTo(257 / 300, 5);
  });

  it("orders models by total input tokens descending", () => {
    const entries = parseUsageEntries([
      line({ model: "small", totalInputTokens: 10, cacheHitRatio: 0 }),
      line({ model: "large", totalInputTokens: 100, cacheHitRatio: 0 }),
    ].join("\n"));
    const summary = summarizeUsage(entries);
    expect(summary.byModel.map((stats) => stats.model)).toEqual(["large", "small"]);
  });
});

describe("formatUsageSummary", () => {
  it("shows a friendly message when there are no requests", () => {
    expect(formatUsageSummary(summarizeUsage([]))).toBe("No usage recorded in this session yet.");
  });

  it("renders a per-model table and a total line", () => {
    const entries = parseUsageEntries([
      line({ model: "alpha", inputTokens: 10, cacheReadTokens: 90, cacheCreationTokens: 20, totalInputTokens: 120, cacheHitRatio: 0.75 }),
      line({ model: "alpha", inputTokens: 5, cacheReadTokens: 95, cacheCreationTokens: 0, totalInputTokens: 100, cacheHitRatio: 0.95 }),
    ].join("\n"));
    const text = formatUsageSummary(summarizeUsage(entries));

    expect(text).toContain("Usage for session session-a (2 requests):");
    expect(text).toContain("anthropic");
    expect(text).toContain("alpha");
    expect(text).toContain("0.75");
    expect(text).toContain("0.85");
    expect(text).toContain("Total input tokens: 220 (cache read 185, 84.1%)");
  });
});
