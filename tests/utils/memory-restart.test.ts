import { afterEach, describe, expect, it } from "vitest";

import {
  MEMORY_RESTART_CONTINUATION_TTL_MS,
  MEMORY_RESTART_MAX_ATTEMPTS,
  MEMORY_RESTART_MIN_GAP_MS,
  MEMORY_RESTART_WINDOW_MS,
  consumedMemoryRestartMarker,
  clearMemoryRotation,
  markMemoryRotation,
  memoryRestartArgs,
  memoryRestartMarkerPath,
  memoryRotationActive,
  nextMemoryRestartMarker,
  parseMemoryRestartMarker,
  pendingContinuation,
  rotationCooldownActive,
  shouldRelaunchForMemoryRestart,
  type MemoryRestartMarker,
} from "../../src/utils/memory-restart.js";

const SESSION = "session-20260828155654859-1591978c";

afterEach(() => clearMemoryRotation());

function marker(overrides: Partial<MemoryRestartMarker> = {}): MemoryRestartMarker {
  return { sessionId: SESSION, requestedAt: "2026-08-29T03:00:00.000Z", attempts: 1, ...overrides };
}

describe("memory restart protocol", () => {
  it("places the marker inside the workspace .flavor tmp directory", () => {
    expect(memoryRestartMarkerPath("/work").replaceAll("\\", "/")).toBe("/work/.flavor/tmp/memory-restart.json");
  });

  it("starts the attempt budget at one and increments inside the window", () => {
    const now = new Date("2026-08-29T03:05:00.000Z");
    const first = nextMemoryRestartMarker(undefined, SESSION, now);
    expect(first).toEqual({ sessionId: SESSION, windowStartedAt: now.toISOString(), requestedAt: now.toISOString(), attempts: 1 });
    const second = nextMemoryRestartMarker(first, SESSION, new Date("2026-08-29T03:06:00.000Z"));
    expect(second.attempts).toBe(2);
  });

  it("resets the budget for a different session or after the window expires", () => {
    const previous = marker({ attempts: 2 });
    expect(nextMemoryRestartMarker(previous, "session-other", new Date("2026-08-29T03:01:00.000Z")).attempts).toBe(1);
    expect(nextMemoryRestartMarker(previous, SESSION, new Date(new Date(previous.requestedAt).getTime() + MEMORY_RESTART_WINDOW_MS + 1)).attempts).toBe(1);
  });

  it("rejects malformed markers", () => {
    expect(parseMemoryRestartMarker("not json")).toBeUndefined();
    expect(parseMemoryRestartMarker(JSON.stringify({ sessionId: SESSION }))).toBeUndefined();
    expect(parseMemoryRestartMarker(JSON.stringify(marker()))).toEqual(marker());
  });

  it("only relaunches within the attempt budget and for sane session ids", () => {
    expect(shouldRelaunchForMemoryRestart(marker())).toBe(true);
    expect(shouldRelaunchForMemoryRestart(marker({ attempts: MEMORY_RESTART_MAX_ATTEMPTS }))).toBe(true);
    expect(shouldRelaunchForMemoryRestart(marker({ attempts: MEMORY_RESTART_MAX_ATTEMPTS + 1 }))).toBe(false);
    expect(shouldRelaunchForMemoryRestart(marker({ sessionId: "not a session; rm -rf /" }))).toBe(false);
    expect(shouldRelaunchForMemoryRestart(undefined)).toBe(false);
  });

  it("replaces any existing --resume selection with the requested session", () => {
    const suffix = ["--resume", SESSION, "--memory-restart"];
    expect(memoryRestartArgs(["-p", "task"], marker())).toEqual(["-p", "task", ...suffix]);
    expect(memoryRestartArgs(["--resume", "session-old", "-p", "task"], marker()))
      .toEqual(["-p", "task", ...suffix]);
    expect(memoryRestartArgs(["--resume=latest", "--print", "task"], marker()))
      .toEqual(["--print", "task", ...suffix]);
    expect(memoryRestartArgs(["--resume", "--memory-restart"], marker())).toEqual(suffix);
  });

  it("refuses to relaunch once the budget is exhausted", () => {
    expect(memoryRestartArgs(["-p", "task"], marker({ attempts: MEMORY_RESTART_MAX_ATTEMPTS + 1 }))).toBeUndefined();
    expect(memoryRestartArgs(["-p", "task"], undefined)).toBeUndefined();
  });

  it("allows a seamless multi-day run to rotate far more often than the old crash budget", () => {
    // 24 rotations per hour still covers a run rotating every few hours for days.
    expect(MEMORY_RESTART_MAX_ATTEMPTS).toBeGreaterThanOrEqual(24);
    expect(MEMORY_RESTART_WINDOW_MS).toBe(60 * 60 * 1_000);
    expect(shouldRelaunchForMemoryRestart(marker({ attempts: 24 }))).toBe(true);
  });

  it("uses a fixed accounting window and does not count continuation consumption as a restart", () => {
    const start = new Date("2026-08-29T03:00:00.000Z");
    const first = nextMemoryRestartMarker(undefined, SESSION, start, { kind: "goal", id: "goal-1" });
    const consumed = consumedMemoryRestartMarker(first);
    expect(consumed).toMatchObject({ attempts: 1, requestedAt: start.toISOString(), windowStartedAt: start.toISOString() });
    expect(consumed.continuation).toBeUndefined();
    const afterWindow = nextMemoryRestartMarker(consumed, SESSION, new Date(start.getTime() + MEMORY_RESTART_WINDOW_MS + 1));
    expect(afterWindow.attempts).toBe(1);
  });

  it("carries a loop or goal continuation through the marker so the relaunched process resumes it", () => {
    const now = new Date("2026-08-29T03:05:00.000Z");
    const withContinuation = nextMemoryRestartMarker(undefined, SESSION, now, { kind: "loop", id: "loop-1" });
    expect(withContinuation.continuation).toEqual({ kind: "loop", id: "loop-1" });
    expect(parseMemoryRestartMarker(JSON.stringify(withContinuation))).toEqual(withContinuation);
    // A marker without a continuation stays free of the key (exactOptionalPropertyTypes).
    expect("continuation" in nextMemoryRestartMarker(undefined, SESSION, now)).toBe(false);
  });

  it("rejects a malformed continuation instead of resuming garbage", () => {
    expect(parseMemoryRestartMarker(JSON.stringify({ ...marker(), continuation: { kind: "task", id: "x" } }))).toBeUndefined();
    expect(parseMemoryRestartMarker(JSON.stringify({ ...marker(), continuation: { kind: "loop" } }))).toBeUndefined();
  });

  it("only honours a continuation for the same session and shortly after it was written", () => {
    const requestedAt = "2026-08-29T03:00:00.000Z";
    const loopMarker = marker({ requestedAt, continuation: { kind: "loop", id: "loop-9" } });
    expect(pendingContinuation(loopMarker, SESSION, new Date(requestedAt))).toEqual({ kind: "loop", id: "loop-9" });
    expect(pendingContinuation(loopMarker, "session-other", new Date(requestedAt))).toBeUndefined();
    expect(pendingContinuation(loopMarker, SESSION, new Date(new Date(requestedAt).getTime() + MEMORY_RESTART_CONTINUATION_TTL_MS + 1))).toBeUndefined();
    expect(pendingContinuation(marker({ requestedAt }), SESSION, new Date(requestedAt))).toBeUndefined();
  });

  it("blocks a rotation requested sooner than the minimum gap so a heavy fresh heap cannot spin", () => {
    const requestedAt = "2026-08-29T03:00:00.000Z";
    const previous = marker({ requestedAt });
    expect(rotationCooldownActive(previous, SESSION, new Date(new Date(requestedAt).getTime() + MEMORY_RESTART_MIN_GAP_MS - 1))).toBe(true);
    expect(rotationCooldownActive(previous, SESSION, new Date(new Date(requestedAt).getTime() + MEMORY_RESTART_MIN_GAP_MS))).toBe(false);
    // A different session or no marker means nothing to cool down from.
    expect(rotationCooldownActive(previous, "session-other", new Date(requestedAt))).toBe(false);
    expect(rotationCooldownActive(undefined, SESSION, new Date(requestedAt))).toBe(false);
  });

  it("flips the process-wide rotation flag so orchestrators skip terminal bookkeeping", () => {
    expect(memoryRotationActive()).toBe(false);
    markMemoryRotation();
    expect(memoryRotationActive()).toBe(true);
  });
});
