import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { SlidingWindow } from "../../src/hallucination/sliding-window.js";

function hashParams(toolName: string, params: unknown): string {
  const sorted = JSON.stringify(params, Object.keys(params as Record<string, unknown>).sort());
  return createHash("sha256").update(`${toolName}:${sorted}`).digest("hex");
}

describe("SlidingWindow", () => {
  it("computes the same hash for identical params regardless of key order", () => {
    const window = new SlidingWindow({ windowSize: 20, threshold: 15 });
    const hash1 = window.hash("Read", { path: "/a", maxBytes: 100 });
    const hash2 = window.hash("Read", { maxBytes: 100, path: "/a" });
    expect(hash1).toBe(hash2);
  });

  it("computes different hashes for different tool names", () => {
    const window = new SlidingWindow({ windowSize: 20, threshold: 15 });
    const hash1 = window.hash("Read", { path: "/a" });
    const hash2 = window.hash("Write", { path: "/a" });
    expect(hash1).not.toBe(hash2);
  });

  it("starts not tripped and with zero count", () => {
    const window = new SlidingWindow({ windowSize: 20, threshold: 15 });
    expect(window.isTripped()).toBe(false);
    expect(window.count).toBe(0);
  });

  it("increments count on push", () => {
    const window = new SlidingWindow({ windowSize: 20, threshold: 15 });
    window.push("Read", { path: "/a" });
    expect(window.count).toBe(1);
    expect(window.isTripped()).toBe(false);
  });

  it("trips when the same hash appears more than threshold times in the window", () => {
    const window = new SlidingWindow({ windowSize: 20, threshold: 15 });
    for (let i = 0; i < 16; i++) {
      window.push("Read", { path: "/a" });
    }
    expect(window.count).toBe(16);
    expect(window.isTripped()).toBe(true);
  });

  it("does NOT trip when different params keep count below threshold", () => {
    const window = new SlidingWindow({ windowSize: 20, threshold: 15 });
    for (let i = 0; i < 16; i++) {
      window.push("Read", { path: `/a/${i}` });
    }
    // Each call has different params, so each hash is unique
    // The most frequent hash appears at most 1 time
    expect(window.isTripped()).toBe(false);
  });

  it("evicts old entries when window overflows", () => {
    const window = new SlidingWindow({ windowSize: 5, threshold: 3 });
    // Fill window with unique params
    for (let i = 0; i < 5; i++) {
      window.push("Read", { path: `/unique/${i}` });
    }
    expect(window.count).toBe(5);
    // Now push same params 4 times — should push old ones out
    for (let i = 0; i < 4; i++) {
      window.push("Read", { path: "/same" });
    }
    expect(window.count).toBe(5); // window max
    // The "/same" hash appears 4 times, which exceeds threshold 3
    expect(window.isTripped()).toBe(true);
  });

  it("trippedHash returns the hash that caused the trip", () => {
    const window = new SlidingWindow({ windowSize: 20, threshold: 15 });
    for (let i = 0; i < 16; i++) {
      window.push("Read", { path: "/loop" });
    }
    const hash = window.hash("Read", { path: "/loop" });
    expect(window.trippedHash).toBe(hash);
  });

  it("trippedToolName returns the tool name that caused the trip", () => {
    const window = new SlidingWindow({ windowSize: 20, threshold: 15 });
    for (let i = 0; i < 16; i++) {
      window.push("Write", { content: "x" });
    }
    expect(window.trippedToolName).toBe("Write");
  });

  it("uses custom windowSize and threshold from config", () => {
    const window = new SlidingWindow({ windowSize: 3, threshold: 2 });
    window.push("Read", { path: "/a" });
    window.push("Read", { path: "/a" });
    window.push("Read", { path: "/a" });
    expect(window.isTripped()).toBe(true);
  });

  it("reset clears the window", () => {
    const window = new SlidingWindow({ windowSize: 20, threshold: 15 });
    for (let i = 0; i < 16; i++) {
      window.push("Read", { path: "/a" });
    }
    expect(window.isTripped()).toBe(true);
    window.reset();
    expect(window.isTripped()).toBe(false);
    expect(window.count).toBe(0);
  });

  it("getFrequency returns the count of a specific hash", () => {
    const window = new SlidingWindow({ windowSize: 20, threshold: 15 });
    window.push("Read", { path: "/a" });
    window.push("Read", { path: "/a" });
    window.push("Read", { path: "/b" });
    const hashA = window.hash("Read", { path: "/a" });
    expect(window.getFrequency(hashA)).toBe(2);
  });
});
