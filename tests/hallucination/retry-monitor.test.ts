import { describe, expect, it } from "vitest";
import { RetryMonitor } from "../../src/hallucination/retry-monitor.js";

describe("RetryMonitor", () => {
  it("starts with zero retries and no violations", () => {
    const monitor = new RetryMonitor({ maxToolRetries: 3 });
    const report = monitor.evaluate();
    expect(report.retryViolations).toEqual([]);
    expect(report.circuitBreakerTripped).toBe(false);
  });

  it("records successful tool calls without counting as retries", () => {
    const monitor = new RetryMonitor({ maxToolRetries: 3 });
    monitor.recordCall("Read", { path: "/a" });
    monitor.recordSuccess("Read");
    monitor.recordCall("Write", { path: "/b" });
    monitor.recordSuccess("Write");
    const report = monitor.evaluate();
    expect(report.retryViolations).toEqual([]);
    expect(report.circuitBreakerTripped).toBe(false);
  });

  it("detects retry when same tool is called again after a failure", () => {
    const monitor = new RetryMonitor({ maxToolRetries: 2 });
    // First call fails
    monitor.recordCall("Read", { path: "/a" });
    monitor.recordError("Read", { path: "/a" }, "tool_error");

    // Second call to same tool = retry
    monitor.recordCall("Read", { path: "/a" });
    monitor.recordError("Read", { path: "/a" }, "tool_error");

    const report = monitor.evaluate();
    expect(report.retryViolations).toHaveLength(1);
    expect(report.retryViolations[0]!.toolName).toBe("Read");
    expect(report.retryViolations[0]!.retryCount).toBe(2);
    expect(report.retryViolations[0]!.lastErrorCode).toBe("tool_error");
  });

  it("resets retry count when a call to the tool succeeds", () => {
    const monitor = new RetryMonitor({ maxToolRetries: 3 });
    // Fail twice
    monitor.recordCall("Read", { path: "/a" });
    monitor.recordError("Read", { path: "/a" }, "tool_error");
    monitor.recordCall("Read", { path: "/a" });
    monitor.recordError("Read", { path: "/a" }, "tool_error");

    // Succeed - retry count resets
    monitor.recordCall("Read", { path: "/a" });
    monitor.recordSuccess("Read");

    const report = monitor.evaluate();
    expect(report.retryViolations).toEqual([]);
  });

  it("does NOT flag retries when below threshold", () => {
    const monitor = new RetryMonitor({ maxToolRetries: 5 });
    for (let i = 0; i < 3; i++) {
      monitor.recordCall("Read", { path: "/a" });
      monitor.recordError("Read", { path: "/a" }, "tool_error");
    }
    const report = monitor.evaluate();
    expect(report.retryViolations).toEqual([]);
  });

  it("flags retries when at or above threshold", () => {
    const monitor = new RetryMonitor({ maxToolRetries: 2 });
    monitor.recordCall("Read", { path: "/a" });
    monitor.recordError("Read", { path: "/a" }, "tool_error");
    monitor.recordCall("Read", { path: "/a" });
    monitor.recordError("Read", { path: "/a" }, "tool_error");

    const report = monitor.evaluate();
    expect(report.retryViolations).toHaveLength(1);
    expect(report.retryViolations[0]!.retryCount).toBe(2);
  });

  it("integrates sliding window for parameter hash detection", () => {
    const monitor = new RetryMonitor({
      maxToolRetries: 20,
      windowSize: 5,
      threshold: 3,
    });

    for (let i = 0; i < 5; i++) {
      monitor.recordCall("Read", { path: "/loop" });
    }

    const report = monitor.evaluate();
    expect(report.circuitBreakerTripped).toBe(true);
    expect(report.circuitBreakerDetail).toContain("Read");
  });

  it("counts one failed invocation once in the sliding window", () => {
    const monitor = new RetryMonitor({
      maxToolRetries: 20,
      windowSize: 3,
      threshold: 1,
    });

    monitor.recordCall("Read", { path: "/one" });
    monitor.recordError("Read", { path: "/one" }, "tool_error");

    expect(monitor.evaluate().circuitBreakerTripped).toBe(false);
  });

  it("circuit breaker resets when different params push old ones out", () => {
    const monitor = new RetryMonitor({
      maxToolRetries: 20,
      windowSize: 5,
      threshold: 2,
    });

    for (let i = 0; i < 4; i++) {
      monitor.recordCall("Read", { path: "/loop" });
    }
    expect(monitor.evaluate().circuitBreakerTripped).toBe(true);

    for (let i = 0; i < 5; i++) {
      monitor.recordCall("Read", { path: `/different/${i}` });
    }
    expect(monitor.evaluate().circuitBreakerTripped).toBe(false);
  });

  it("computes consistent hash for params with different key order", () => {
    const monitor = new RetryMonitor({
      maxToolRetries: 20,
      windowSize: 5,
      threshold: 2,
    });

    monitor.recordCall("Read", { path: "/a", maxBytes: 100 });
    monitor.recordCall("Read", { maxBytes: 100, path: "/a" });
    monitor.recordCall("Read", { path: "/a", maxBytes: 100 });

    const report = monitor.evaluate();
    expect(report.circuitBreakerTripped).toBe(true);
  });

  it("reset clears all state", () => {
    const monitor = new RetryMonitor({ maxToolRetries: 2, windowSize: 5, threshold: 2 });
    monitor.recordCall("Read", { path: "/a" });
    monitor.recordError("Read", { path: "/a" }, "tool_error");
    monitor.recordCall("Read", { path: "/a" });
    monitor.recordError("Read", { path: "/a" }, "tool_error");

    let report = monitor.evaluate();
    expect(report.retryViolations).toHaveLength(1);

    monitor.reset();

    report = monitor.evaluate();
    expect(report.retryViolations).toEqual([]);
    expect(report.circuitBreakerTripped).toBe(false);
  });

  it("tracks retries independently per tool name", () => {
    const monitor = new RetryMonitor({ maxToolRetries: 2 });
    monitor.recordCall("Read", { path: "/a" });
    monitor.recordError("Read", { path: "/a" }, "tool_error");
    monitor.recordCall("Read", { path: "/a" });
    monitor.recordError("Read", { path: "/a" }, "tool_error");

    monitor.recordCall("Write", { path: "/b" });
    monitor.recordSuccess("Write");

    const report = monitor.evaluate();
    expect(report.retryViolations).toHaveLength(1);
    expect(report.retryViolations[0]!.toolName).toBe("Read");
  });
});
