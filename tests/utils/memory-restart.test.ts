import { describe, expect, it } from "vitest";

import {
  MEMORY_RESTART_MAX_ATTEMPTS,
  MEMORY_RESTART_WINDOW_MS,
  memoryRestartArgs,
  memoryRestartMarkerPath,
  nextMemoryRestartMarker,
  parseMemoryRestartMarker,
  shouldRelaunchForMemoryRestart,
  type MemoryRestartMarker,
} from "../../src/utils/memory-restart.js";

const SESSION = "session-20260828155654859-1591978c";

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
    expect(first).toEqual({ sessionId: SESSION, requestedAt: now.toISOString(), attempts: 1 });
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
    expect(memoryRestartArgs(["-p", "task"], marker())).toEqual(["-p", "task", "--resume", SESSION]);
    expect(memoryRestartArgs(["--resume", "session-old", "-p", "task"], marker()))
      .toEqual(["-p", "task", "--resume", SESSION]);
    expect(memoryRestartArgs(["--resume=latest", "--print", "task"], marker()))
      .toEqual(["--print", "task", "--resume", SESSION]);
    expect(memoryRestartArgs(["--resume"], marker())).toEqual(["--resume", SESSION]);
  });

  it("refuses to relaunch once the budget is exhausted", () => {
    expect(memoryRestartArgs(["-p", "task"], marker({ attempts: MEMORY_RESTART_MAX_ATTEMPTS + 1 }))).toBeUndefined();
    expect(memoryRestartArgs(["-p", "task"], undefined)).toBeUndefined();
  });
});
