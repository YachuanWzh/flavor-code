import { describe, expect, it } from "vitest";

import { alignElements } from "../../src/d2c/align.js";
import type { D2cElementSnapshot, D2cRect } from "../../src/d2c/types.js";

let nextId = 1;
function element(overrides: Partial<D2cElementSnapshot> & { rect: D2cRect }): D2cElementSnapshot {
  return {
    id: nextId++,
    tag: "div",
    text: "",
    styles: {},
    hasImage: false,
    ...overrides,
  };
}

describe("alignElements", () => {
  it("pairs elements with identical unique text regardless of position", () => {
    nextId = 1;
    const design = [element({ text: "立即购买", rect: { x: 0, y: 0, width: 100, height: 40 } })];
    const impl = [element({ text: "立即购买", rect: { x: 300, y: 500, width: 100, height: 40 } })];
    const result = alignElements(design, impl);
    expect(result.matched).toHaveLength(1);
    expect(result.matched[0]!.design.text).toBe("立即购买");
    expect(result.matched[0]!.impl).toBe(impl[0]);
    expect(result.missing).toEqual([]);
    expect(result.extra).toEqual([]);
  });

  it("pairs textless elements by bounding-box IoU", () => {
    nextId = 1;
    const design = [element({ rect: { x: 10, y: 10, width: 100, height: 100 } })];
    const impl = [element({ rect: { x: 14, y: 12, width: 100, height: 100 } })];
    const result = alignElements(design, impl);
    expect(result.matched).toHaveLength(1);
    expect(result.missing).toEqual([]);
    expect(result.extra).toEqual([]);
  });

  it("leaves far-apart textless elements unmatched", () => {
    nextId = 1;
    const design = [element({ rect: { x: 0, y: 0, width: 50, height: 50 } })];
    const impl = [element({ rect: { x: 800, y: 800, width: 50, height: 50 } })];
    const result = alignElements(design, impl);
    expect(result.matched).toEqual([]);
    expect(result.missing).toEqual(design);
    expect(result.extra).toEqual(impl);
  });

  it("resolves duplicated texts by spatial proximity", () => {
    nextId = 1;
    const near = element({ text: "按钮", rect: { x: 10, y: 10, width: 80, height: 32 } });
    const far = element({ text: "按钮", rect: { x: 500, y: 10, width: 80, height: 32 } });
    const implNear = element({ text: "按钮", rect: { x: 12, y: 11, width: 80, height: 32 } });
    const implFar = element({ text: "按钮", rect: { x: 505, y: 12, width: 80, height: 32 } });
    const result = alignElements([near, far], [implFar, implNear]);
    expect(result.matched).toHaveLength(2);
    const pairs = new Map(result.matched.map(({ design, impl }) => [design.id, impl.id]));
    expect(pairs.get(near.id)).toBe(implNear.id);
    expect(pairs.get(far.id)).toBe(implFar.id);
  });

  it("never uses an element twice", () => {
    nextId = 1;
    const design = [
      element({ text: "标题", rect: { x: 0, y: 0, width: 200, height: 30 } }),
      element({ text: "标题", rect: { x: 0, y: 40, width: 200, height: 30 } }),
    ];
    const impl = [element({ text: "标题", rect: { x: 2, y: 2, width: 200, height: 30 } })];
    const result = alignElements(design, impl);
    expect(result.matched).toHaveLength(1);
    expect(result.missing).toHaveLength(1);
    expect(result.extra).toEqual([]);
  });

  it("normalizes text case and whitespace before matching", () => {
    nextId = 1;
    const design = [element({ text: "  Hello   World ", rect: { x: 0, y: 0, width: 100, height: 20 } })];
    const impl = [element({ text: "hello world", rect: { x: 700, y: 700, width: 100, height: 20 } })];
    const result = alignElements(design, impl);
    expect(result.matched).toHaveLength(1);
  });
});
