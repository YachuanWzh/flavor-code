import { describe, expect, it } from "vitest";
import { highlightCode } from "../../src/ui/highlight.js";

const ANSI_RE = /\x1B\[[0-?]*[ -/]*[@-~]/;

describe("highlightCode", () => {
  it("returns empty string for empty input", () => {
    expect(highlightCode("", "javascript")).toBe("");
    expect(highlightCode("", undefined)).toBe("");
  });

  it("preserves line breaks across multi-line input", () => {
    const out = highlightCode("a\nb\nc", "javascript");
    expect(out).toContain("\n");
    expect(out.split("\n")).toHaveLength(3);
  });

  it("emits ANSI escape sequences for known language keywords", () => {
    const out = highlightCode("function foo() {}", "javascript");
    expect(out).toMatch(ANSI_RE);
  });

  it("emits ANSI even when language is undefined", () => {
    const out = highlightCode("const x = 'hello'", undefined);
    expect(out).toMatch(ANSI_RE);
  });

  it("does not crash on unknown language and still colorises basic tokens", () => {
    const out = highlightCode('// a comment', "brainfuck");
    expect(out).toMatch(ANSI_RE); // comments still get a colour
    expect(out).toContain("a comment");
  });

  it("preserves code contents inside styled output", () => {
    const source = "function greet(name) { return 'hi'; }";
    const out = highlightCode(source, "javascript");
    expect(out.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "")).toBe(source);
  });

  it("recognises python comment style", () => {
    const out = highlightCode("# this is a comment", "python");
    expect(out).toMatch(ANSI_RE);
  });

  it("recognises bash keywords", () => {
    const out = highlightCode("if true; then echo hi; fi", "bash");
    expect(out).toMatch(ANSI_RE);
  });
});
