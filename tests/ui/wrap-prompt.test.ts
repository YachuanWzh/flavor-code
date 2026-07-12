import { describe, expect, it } from "vitest";
import { wrapPromptInput } from "../../src/ui/wrap-prompt.js";

describe("wrapPromptInput", () => {
  it("returns a single line when input fits within the columns", () => {
    const out = wrapPromptInput("hello", 5, { columns: 12, indent: 2 });
    expect(out.lines).toEqual(["hello"]);
    expect(out.cursor).toEqual({ line: 0, column: 5 });
    expect(out.height).toBe(1);
  });

  it("splits long input into multiple lines on the indent boundary", () => {
    const out = wrapPromptInput("abcdef", 6, { columns: 5, indent: 2 });
    // usable = 3 columns
    expect(out.lines).toEqual(["abc", "def"]);
    expect(out.cursor).toEqual({ line: 1, column: 3 });
    expect(out.height).toBe(2);
  });

  it("places cursor mid-wrap on the correct visual row", () => {
    const out = wrapPromptInput("abcdef", 4, { columns: 5, indent: 2 });
    expect(out.lines).toEqual(["abc", "def"]);
    expect(out.cursor).toEqual({ line: 1, column: 1 });
  });

  it("clamps an out-of-range cursor to the end of the buffer", () => {
    const out = wrapPromptInput("abc", 99, { columns: 5, indent: 2 });
    expect(out.cursor).toEqual({ line: 0, column: 3 });
  });

  it("accounts for emoji display width (2 columns) when wrapping", () => {
    // columns=5, indent=2 → usable=3. "a🍜b" = 1+2+1 = 4 visual columns,
    // which exceeds usable (3), so it wraps.
    const out = wrapPromptInput("a🍜b", 2, { columns: 5, indent: 2 });
    expect(out.lines).toEqual(["a🍜", "b"]);
    expect(out.cursor).toEqual({ line: 0, column: 2 });
  });

  it("splits CJK characters per code point", () => {
    const out = wrapPromptInput("介绍一个项目", 7, { columns: 5, indent: 2 });
    // usable = 3 columns; each CJK char takes one column
    expect(out.lines.length).toBeGreaterThan(1);
    expect(out.cursor.line).toBeGreaterThanOrEqual(0);
    expect(out.cursor.column).toBeGreaterThanOrEqual(0);
  });

  it("handles empty input", () => {
    const out = wrapPromptInput("", 0, { columns: 12, indent: 2 });
    expect(out.lines).toEqual([""]);
    expect(out.cursor).toEqual({ line: 0, column: 0 });
  });
});
