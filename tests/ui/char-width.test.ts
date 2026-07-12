import { describe, expect, it } from "vitest";
import { charWidth } from "../../src/ui/char-width.js";

describe("charWidth", () => {
  it("returns 1 for ASCII letters", () => {
    expect(charWidth("a".codePointAt(0)!)).toBe(1);
    expect(charWidth("Z".codePointAt(0)!)).toBe(1);
    expect(charWidth("0".codePointAt(0)!)).toBe(1);
  });

  it("returns 1 for common punctuation", () => {
    expect(charWidth(".".codePointAt(0)!)).toBe(1);
    expect(charWidth(" ".codePointAt(0)!)).toBe(1);
    expect(charWidth("-".codePointAt(0)!)).toBe(1);
  });

  it("returns 2 for CJK Unified Ideographs", () => {
    expect(charWidth("你".codePointAt(0)!)).toBe(2);
    expect(charWidth("好".codePointAt(0)!)).toBe(2);
    expect(charWidth("中".codePointAt(0)!)).toBe(2);
    expect(charWidth("介".codePointAt(0)!)).toBe(2);
  });

  it("returns 2 for Hiragana and Katakana", () => {
    expect(charWidth("あ".codePointAt(0)!)).toBe(2); // Hiragana
    expect(charWidth("ア".codePointAt(0)!)).toBe(2); // Katakana
  });

  it("returns 2 for Hangul", () => {
    expect(charWidth("한".codePointAt(0)!)).toBe(2);
    expect(charWidth("글".codePointAt(0)!)).toBe(2);
  });

  it("returns 2 for Fullwidth forms", () => {
    expect(charWidth("Ａ".codePointAt(0)!)).toBe(2); // Fullwidth 'A'
    expect(charWidth("！".codePointAt(0)!)).toBe(2); // Fullwidth '!'
  });

  it("returns 2 for common emoji", () => {
    expect(charWidth("🍜".codePointAt(0)!)).toBe(2); // U+1F35C
    expect(charWidth("😀".codePointAt(0)!)).toBe(2); // U+1F600
  });

  it("returns 0 for combining marks", () => {
    expect(charWidth(0x0301)).toBe(0); // combining acute accent
    expect(charWidth(0x0300)).toBe(0); // combining grave accent
  });

  it("returns 0 for zero-width characters", () => {
    expect(charWidth(0x200B)).toBe(0); // zero-width space
    expect(charWidth(0x200D)).toBe(0); // zero-width joiner
    expect(charWidth(0xFEFF)).toBe(0); // BOM
  });

  it("returns 1 for Latin-1 supplement characters", () => {
    expect(charWidth("é".codePointAt(0)!)).toBe(1); // precomposed, not combining
    expect(charWidth("ñ".codePointAt(0)!)).toBe(1);
  });
});
