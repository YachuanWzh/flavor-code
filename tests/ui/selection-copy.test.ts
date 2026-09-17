import { describe, expect, it } from "vitest";

import {
  createSelectionState,
  finishSelection,
  shouldCopySelectionOnRelease,
  startSelection,
  updateSelection,
} from "../../src/claude-ink/selection.js";

describe("macOS terminal selection copy fallback", () => {
  it("copies only when a real drag selection finishes on macOS", () => {
    const selection = createSelectionState();
    startSelection(selection, 1, 1);
    expect(shouldCopySelectionOnRelease(false, selection, "darwin")).toBe(false);

    updateSelection(selection, 5, 1);
    const wasDragging = selection.isDragging;
    finishSelection(selection);

    expect(shouldCopySelectionOnRelease(wasDragging, selection, "darwin")).toBe(true);
    expect(shouldCopySelectionOnRelease(wasDragging, selection, "win32")).toBe(false);
    expect(shouldCopySelectionOnRelease(false, selection, "darwin")).toBe(false);
  });

  it("does not overwrite the clipboard after a click without selection", () => {
    const selection = createSelectionState();
    startSelection(selection, 1, 1);
    const wasDragging = selection.isDragging;
    finishSelection(selection);

    expect(shouldCopySelectionOnRelease(wasDragging, selection, "darwin")).toBe(false);
  });
});
