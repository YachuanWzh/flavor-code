import { describe, expect, it } from "vitest";

import { activityFrame, formatElapsed, statusPresentation } from "../../src/ui/task-progress-model.js";
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
      color: "yellow",
    });
  });

  it("renders a static running marker for non-interactive output", () => {
    expect(statusPresentation(runningTask, 4_900, false)).toMatchObject({ glyph: "·", text: "Inspecting code" });
  });
});
