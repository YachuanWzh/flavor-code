import { describe, expect, it } from "vitest";
import {
  buildScrollRegionEscape,
  moveCursor,
  RESET_SCROLL_REGION,
  HIDE_CURSOR,
  SHOW_CURSOR,
} from "../../src/ui/scroll-region.js";

describe("scroll-region escape helpers", () => {
  it("builds the DECSTBM escape with the row bound", () => {
    expect(buildScrollRegionEscape(20)).toBe("\x1B[1;20r");
    expect(buildScrollRegionEscape(1)).toBe("\x1B[1;1r");
  });

  it("exposes a constant reset escape", () => {
    expect(RESET_SCROLL_REGION).toBe("\x1B[r");
  });

  it("exposes cursor visibility toggles", () => {
    expect(HIDE_CURSOR).toBe("\x1B[?25l");
    expect(SHOW_CURSOR).toBe("\x1B[?25h");
  });

  it("builds absolute cursor move escapes", () => {
    expect(moveCursor(1, 1)).toBe("\x1B[1;1H");
    expect(moveCursor(10, 5)).toBe("\x1B[10;5H");
  });
});
