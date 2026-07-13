import { describe, expect, it } from "vitest";

import { activityFrame, formatElapsed, staticTaskLines, statusPresentation } from "../../src/ui/task-progress-model.js";
import type { TranscriptBlock } from "../../src/ui/transcript.js";

const runningTask: Extract<TranscriptBlock, { kind: "status" }> = {
  kind: "status",
  id: "task:inspect",
  state: "running",
  text: "Inspecting code",
  task: { subject: "Inspect code", activeForm: "Inspecting code", role: "main" },
};

describe("task progress presentation", () => {
  it("cycles spinner frames every 120ms", () => {
    expect(activityFrame(0)).toBe("⠋");
    expect(activityFrame(120)).not.toBe(activityFrame(0));
    expect(activityFrame(1_200)).toBe(activityFrame(0));
  });

  it("formats elapsed time at one-second granularity", () => {
    expect(formatElapsed(0)).toBe("0s");
    expect(formatElapsed(4_900)).toBe("4s");
  });

  it("uses activeForm for an interactive running task", () => {
    expect(statusPresentation(runningTask, 4_900, true)).toEqual({
      glyph: activityFrame(4_900),
      text: "Inspecting code… (4s)",
      color: "#d77757",
    });
  });

  it("renders a static running marker for non-interactive output", () => {
    expect(statusPresentation(runningTask, 4_900, false)).toMatchObject({ glyph: "·", text: "Inspecting code" });
  });

  it("identifies a running delegated task with a subagent badge", () => {
    const result = statusPresentation({
      ...runningTask,
      id: "subagent:inspect",
      task: { subject: "Inspect worker", activeForm: "Inspecting worker", role: "subagent" },
    }, 4_900, true);
    expect(result).toMatchObject({
      text: "Inspecting worker… (4s)",
      badge: "subagent:",
      badgeColor: "#81c8f2",
    });
  });

  it("identifies static delegated rows without changing main plan labels", () => {
    expect(staticTaskLines({
      plan: { tasks: [{
        id: "main", subject: "Main task", activeForm: "Running main task", status: "pending", dependencies: [],
      }] },
      subagents: {
        graph: { nodes: [{
          id: "worker", description: "Inspect worker", dependencies: [], expectedOutputs: [], verification: [],
        }] },
        states: { worker: "cancelled" },
      },
    })).toEqual([
      "· Main task · pending",
      "× subagent: Inspect worker · cancelled",
    ]);
  });

  it.each([
    ["completed", "✓", "Run tests · done (8s)"],
    ["failed", "×", "Run tests · failed (8s)"],
    ["cancelled", "×", "Run tests · cancelled (8s)"],
  ] as const)("renders %s task duration in the static terminal row", (state, glyph, text) => {
    expect(statusPresentation({
      kind: "status", id: "task:test", state, text: `${glyph} Run tests · ${state === "completed" ? "done" : state}`,
      task: { subject: "Run tests", activeForm: "Running tests", role: "main" }, elapsedMs: 8_000,
    }, 0, false)).toEqual({ glyph, text, color: state === "completed" ? "ansi:green" : "#e06c50" });
  });
});
