import { describe, expect, it } from "vitest";
import { ToolOutcomeCollector } from "../../src/rsi/observer.js";
import type { RsiToolOutcome, RsiToolTerminal } from "../../src/rsi/types.js";

function terminal(
  toolCallId: string,
  outcome: RsiToolOutcome,
  overrides: Partial<RsiToolTerminal> = {},
): RsiToolTerminal {
  return { sessionId: "s1", runId: "r1", toolCallId, tool: "Shell", outcome, ...overrides };
}

describe("ToolOutcomeCollector (P0-02b / E2)", () => {
  it("10 failures / 90 successes across unique calls gives a 0.10 rate", () => {
    const collector = new ToolOutcomeCollector();
    for (let i = 0; i < 90; i += 1) collector.record(terminal(`ok-${i}`, "success"));
    for (let i = 0; i < 10; i += 1) collector.record(terminal(`bad-${i}`, "failure"));
    const snap = collector.snapshot();
    expect(snap.comparableCalls).toBe(100);
    expect(snap.failureRate).toBeCloseTo(0.1);
    expect(snap.evidenceComplete).toBe(true);
  });

  it("1 failure / 1 success is 0.50 — fewer raw failures never proves improvement", () => {
    const collector = new ToolOutcomeCollector();
    collector.record(terminal("a", "failure"));
    collector.record(terminal("b", "success"));
    const snap = collector.snapshot();
    expect(snap.failureRate).toBeCloseTo(0.5);
    // Contrast: previous run was 100 calls / 10 failures (0.10). A drop to a
    // single failure is NOT an improvement signal; this is the rsi.md gap-one
    // regression case.
    expect(snap.failureRate).toBeGreaterThan(0.1);
  });

  it("no calls yields a null rate, not 0%", () => {
    const collector = new ToolOutcomeCollector();
    const snap = collector.snapshot();
    expect(snap.failureRate).toBeNull();
    expect(snap.comparableCalls).toBe(0);
  });

  it("duplicate terminal notifications for one call count once", () => {
    const collector = new ToolOutcomeCollector();
    expect(collector.record(terminal("dup", "failure"))).toBe("added");
    expect(collector.record(terminal("dup", "failure"))).toBe("duplicate");
    const snap = collector.snapshot();
    expect(snap.failure).toBe(1);
    expect(snap.comparableCalls).toBe(1);
    expect(snap.evidenceComplete).toBe(true);
  });

  it("the same toolCallId in different runs stays two separate calls", () => {
    const collector = new ToolOutcomeCollector();
    collector.record(terminal("shared", "failure", { runId: "rA" }));
    collector.record(terminal("shared", "success", { runId: "rB" }));
    const snap = collector.snapshot();
    expect(snap.comparableCalls).toBe(2);
    expect(snap.failureRate).toBeCloseTo(0.5);
  });

  it("success-then-failure for one call flags a conflict and keeps the first terminal", () => {
    const collector = new ToolOutcomeCollector();
    collector.record(terminal("flip", "success"));
    expect(collector.record(terminal("flip", "failure"))).toBe("conflict");
    const snap = collector.snapshot();
    expect(snap.conflicts).toBe(1);
    expect(snap.evidenceComplete).toBe(false);
    // Must not silently switch to the outcome favouring either side: the
    // first recording stands (1 success), the conflict is counted separately.
    expect(snap.success).toBe(1);
    expect(snap.failure).toBe(0);
  });

  it("explicit cancellations are excluded from the rate but reported", () => {
    const collector = new ToolOutcomeCollector();
    collector.record(terminal("c1", "cancelled"));
    collector.record(terminal("c2", "cancelled"));
    collector.record(terminal("f1", "failure"));
    collector.record(terminal("s1", "success"));
    const snap = collector.snapshot();
    expect(snap.cancelled).toBe(2);
    expect(snap.comparableCalls).toBe(2);
    expect(snap.failureRate).toBeCloseTo(0.5);
  });

  it("finalize returns the snapshot and releases memory for the next episode", () => {
    const collector = new ToolOutcomeCollector();
    collector.record(terminal("x", "failure"));
    const final = collector.finalize();
    expect(final.failure).toBe(1);
    expect(final.failureRate).toBe(1);
    expect(collector.snapshot().comparableCalls).toBe(0);
    expect(collector.snapshot().failureRate).toBeNull();
  });
});
