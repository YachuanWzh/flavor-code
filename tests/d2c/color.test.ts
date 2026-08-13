import { describe, expect, it } from "vitest";

import { deltaE76, normalizeColor } from "../../src/d2c/color.js";

describe("normalizeColor", () => {
  it("normalizes hex shorthand and mixed case to lowercase #rrggbb", () => {
    expect(normalizeColor("#FFF")).toBe("#ffffff");
    expect(normalizeColor("#1a2B3c")).toBe("#1a2b3c");
  });

  it("parses rgb() and rgba() functional notation", () => {
    expect(normalizeColor("rgb(255, 0, 0)")).toBe("#ff0000");
    expect(normalizeColor("rgba(18,52,86,0.999)")).toBe("#123456");
  });

  it("returns undefined for fully transparent colors", () => {
    expect(normalizeColor("rgba(0,0,0,0)")).toBeUndefined();
    expect(normalizeColor("transparent")).toBeUndefined();
  });

  it("returns undefined for invalid input", () => {
    expect(normalizeColor("not-a-color")).toBeUndefined();
    expect(normalizeColor("#12345")).toBeUndefined();
    expect(normalizeColor("")).toBeUndefined();
  });
});

describe("deltaE76", () => {
  it("is zero for identical colors", () => {
    expect(deltaE76("#333333", "#333333")).toBe(0);
  });

  it("orders perceptual distance monotonically", () => {
    const jitter = deltaE76("#333333", "#343434");
    const moderate = deltaE76("#333333", "#666666");
    const extreme = deltaE76("#000000", "#ffffff");
    expect(jitter).toBeLessThan(3);
    expect(moderate).toBeGreaterThan(3);
    expect(extreme).toBeGreaterThan(moderate);
    expect(extreme).toBeGreaterThan(50);
  });

  it("throws for colors that cannot be normalized", () => {
    expect(() => deltaE76("nope", "#000000")).toThrow();
  });
});
