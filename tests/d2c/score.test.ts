import { describe, expect, it } from "vitest";

import { diffPages } from "../../src/d2c/diff.js";
import { computeScores, gradeFor } from "../../src/d2c/score.js";
import type { D2cElementSnapshot, D2cPageSnapshot, D2cRect } from "../../src/d2c/types.js";

let nextId = 1;
function element(overrides: Partial<D2cElementSnapshot> & { rect: D2cRect }): D2cElementSnapshot {
  return { id: nextId++, tag: "div", text: "", styles: {}, hasImage: false, ...overrides };
}
function page(elements: D2cElementSnapshot[], width = 1440, height = 900): D2cPageSnapshot {
  return { width, height, elements };
}

describe("computeScores", () => {
  it("scores identical pages at 100 with pixel-perfect grade", () => {
    nextId = 1;
    const design = page([element({ text: "标题", rect: { x: 10, y: 10, width: 200, height: 40 } })]);
    const impl = page([element({ text: "标题", rect: { x: 10, y: 10, width: 200, height: 40 } })]);
    const scores = computeScores(design, diffPages(design, impl), 0);
    expect(scores.total).toBe(100);
    expect(scores.grade).toBe("像素级还原");
    expect(scores.layout).toBe(1);
    expect(scores.color).toBe(1);
    expect(scores.typography).toBe(1);
    expect(scores.pixel).toBe(1);
  });

  it("applies the documented weights (color mismatch over half the area yields 85)", () => {
    nextId = 1;
    const design = page([
      element({ rect: { x: 0, y: 0, width: 10, height: 10 }, styles: { backgroundColor: "#333333" } }),
      element({ rect: { x: 20, y: 0, width: 10, height: 10 }, styles: { backgroundColor: "#333333" } }),
    ]);
    const impl = page([
      element({ rect: { x: 0, y: 0, width: 10, height: 10 }, styles: { backgroundColor: "#666666" } }),
      element({ rect: { x: 20, y: 0, width: 10, height: 10 }, styles: { backgroundColor: "#333333" } }),
    ]);
    const scores = computeScores(design, diffPages(design, impl), 0);
    expect(scores.color).toBe(0.5);
    expect(scores.total).toBe(85);
    expect(scores.grade).toBe("合格");
  });

  it("penalizes missing elements through the layout score", () => {
    nextId = 1;
    const design = page([element({ text: "A", rect: { x: 0, y: 0, width: 10, height: 10 } })]);
    const impl = page([]);
    const scores = computeScores(design, diffPages(design, impl), 0);
    expect(scores.layout).toBe(0);
    expect(scores.total).toBeLessThan(80);
    expect(scores.grade).toBe("需修复");
  });

  it("penalizes geometry offsets proportionally to offset magnitude", () => {
    nextId = 1;
    const design = page([element({ rect: { x: 0, y: 0, width: 100, height: 100 } })]);
    const shifted = page([element({ rect: { x: 4, y: 0, width: 100, height: 100 } })]);
    const far = page([element({ rect: { x: 8, y: 0, width: 100, height: 100 } })]);
    const small = computeScores(design, diffPages(design, shifted), 0);
    const large = computeScores(design, diffPages(design, far), 0);
    expect(small.layout).toBeCloseTo(0.5, 5);
    expect(large.layout).toBe(0);
    expect(small.total).toBeGreaterThan(large.total);
  });

  it("renormalizes weights when the pixel score is unavailable", () => {
    nextId = 1;
    const design = page([element({ text: "标题", rect: { x: 10, y: 10, width: 200, height: 40 } })]);
    const scores = computeScores(design, diffPages(design, design), undefined);
    expect(scores.pixel).toBeUndefined();
    expect(scores.total).toBe(100);
  });

  it("counts typography only over matched text elements", () => {
    nextId = 1;
    const design = page([
      element({ text: "甲", rect: { x: 0, y: 0, width: 50, height: 20 }, styles: { fontSize: 14 } }),
      element({ text: "乙", rect: { x: 0, y: 30, width: 50, height: 20 }, styles: { fontSize: 14 } }),
      element({ rect: { x: 0, y: 60, width: 50, height: 20 } }),
    ]);
    const impl = page([
      element({ text: "甲", rect: { x: 0, y: 0, width: 50, height: 20 }, styles: { fontSize: 16 } }),
      element({ text: "乙", rect: { x: 0, y: 30, width: 50, height: 20 }, styles: { fontSize: 14 } }),
      element({ rect: { x: 0, y: 60, width: 50, height: 20 } }),
    ]);
    const scores = computeScores(design, diffPages(design, impl), 0);
    expect(scores.typography).toBe(0.5);
  });
});

describe("gradeFor", () => {
  it("maps thresholds inclusively at the lower bound", () => {
    expect(gradeFor(95)).toBe("像素级还原");
    expect(gradeFor(94.9)).toBe("优秀");
    expect(gradeFor(90)).toBe("优秀");
    expect(gradeFor(89.9)).toBe("合格");
    expect(gradeFor(80)).toBe("合格");
    expect(gradeFor(79.9)).toBe("需修复");
  });
});
