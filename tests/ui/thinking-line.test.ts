import { describe, expect, it } from "vitest";

import {
  appendThinkingText,
  normalizeThinkingText,
  sliceThinkingByWidth,
  thinkingDisplayWidth,
  thinkingWindow,
  THINKING_MAX_STORED_CHARS,
} from "../../src/ui/thinking-line.js";

describe("normalizeThinkingText", () => {
  it("collapses newlines and repeated whitespace into single spaces", () => {
    expect(normalizeThinkingText("a\n\n  b\t c ")).toBe("a b c");
  });
});

describe("thinkingDisplayWidth", () => {
  it("counts CJK characters as two cells", () => {
    expect(thinkingDisplayWidth("中文")).toBe(4);
    expect(thinkingDisplayWidth("ab中文")).toBe(6);
  });
});

describe("sliceThinkingByWidth", () => {
  it("slices by display cells and keeps wide characters whole", () => {
    expect(sliceThinkingByWidth("ab中文de", 0, 4)).toBe("ab中");
    // A wide character straddling the window edge is kept rather than halved.
    expect(sliceThinkingByWidth("ab中文de", 4, 2)).toBe("文");
    expect(sliceThinkingByWidth("ab中文de", 6, 2)).toBe("de");
  });

  it("returns an empty string past the end", () => {
    expect(sliceThinkingByWidth("abc", 10, 4)).toBe("");
  });
});

describe("thinkingWindow", () => {
  it("returns the whole text while it fits in the fixed width", () => {
    expect(thinkingWindow("short thought", 0, { width: 40, dtMs: 5_000 }))
      .toEqual({ text: "short thought", start: 0 });
  });

  it("stays pinned at the start right after an overflow", () => {
    const text = "x".repeat(50);
    expect(thinkingWindow(text, 0, { width: 20, dtMs: 0 }).text).toBe(text.slice(0, 20));
  });

  it("pushes the viewport left over successive updates", () => {
    const text = "x".repeat(200);
    const first = thinkingWindow(text, 0, { width: 20, dtMs: 120, cellsPerSecond: 16, ease: 0 });
    expect(first.start).toBeGreaterThan(0);
    const second = thinkingWindow(text, first.start, { width: 20, dtMs: 120, cellsPerSecond: 16, ease: 0 });
    expect(second.start).toBe(first.start + 1);
    expect(second.text).toBe(text.slice(second.start, second.start + 20));
  });

  it("eases the chase faster when the lag grows", () => {
    const text = "x".repeat(400);
    const gentle = thinkingWindow(text, 0, { width: 20, dtMs: 120, cellsPerSecond: 16, ease: 0.18 });
    expect(gentle.start).toBeGreaterThan(1);
  });

  it("clamps so the final window stays pinned at the tail", () => {
    const text = "x".repeat(50);
    const result = thinkingWindow(text, 999, { width: 20, dtMs: 120 });
    expect(result.start).toBe(30);
    expect(result.text).toBe(text.slice(30, 50));
  });

  it("caps one step's elapsed time after a paused clock", () => {
    const text = "x".repeat(1_000);
    const result = thinkingWindow(text, 0, { width: 20, dtMs: 600_000, ease: 0, cellsPerSecond: 16 });
    // 250 ms cap at 16 cells/s ⇒ at most 4 cells per update.
    expect(result.start).toBe(4);
  });

  it("tracks CJK widths when scrolling", () => {
    const text = "中".repeat(20); // 40 cells
    const result = thinkingWindow(text, 10, { width: 10, dtMs: 0, cellsPerSecond: 16, ease: 0 });
    expect(result.text).toBe("中".repeat(5));
  });
});

describe("appendThinkingText", () => {
  it("accumulates deltas", () => {
    expect(appendThinkingText(appendThinkingText(undefined, "ab"), "cd")).toBe("abcd");
  });

  it("keeps only the tail once the cap is exceeded", () => {
    const long = "x".repeat(THINKING_MAX_STORED_CHARS + 10);
    expect(appendThinkingText(long, "y")).toHaveLength(THINKING_MAX_STORED_CHARS);
    expect(appendThinkingText(long, "y").endsWith("y")).toBe(true);
  });
});
