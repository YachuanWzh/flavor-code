import { describe, expect, it } from "vitest";

import { diffPages } from "../../src/d2c/diff.js";
import type { D2cElementSnapshot, D2cPageSnapshot, D2cRect } from "../../src/d2c/types.js";

let nextId = 1;
function element(overrides: Partial<D2cElementSnapshot> & { rect: D2cRect }): D2cElementSnapshot {
  return { id: nextId++, tag: "div", text: "", styles: {}, hasImage: false, ...overrides };
}
function page(elements: D2cElementSnapshot[], width = 1440, height = 900): D2cPageSnapshot {
  return { width, height, elements };
}

describe("diffPages", () => {
  it("reports no diff for sub-tolerance jitter", () => {
    nextId = 1;
    const design = page([element({ text: "标题", rect: { x: 100, y: 100, width: 200, height: 40 } })]);
    const impl = page([element({ text: "标题", rect: { x: 101, y: 99, width: 201, height: 40 } })]);
    const result = diffPages(design, impl);
    expect(result.diffs).toEqual([]);
    expect(result.missing).toEqual([]);
    expect(result.extra).toEqual([]);
    expect(result.matched).toHaveLength(1);
  });

  it("reports geometry offsets beyond tolerance with severity minor", () => {
    nextId = 1;
    const design = page([element({ text: "标题", rect: { x: 100, y: 100, width: 200, height: 40 } })]);
    const impl = page([element({ text: "标题", rect: { x: 105, y: 100, width: 200, height: 40 } })]);
    const result = diffPages(design, impl);
    expect(result.diffs).toHaveLength(1);
    const diff = result.diffs[0]!;
    expect(diff.dx).toBe(5);
    expect(diff.dy).toBe(0);
    expect(diff.severity).toBe("minor");
    expect(diff.label).toContain("标题");
  });

  it("marks large offsets as major", () => {
    nextId = 1;
    const design = page([element({ rect: { x: 0, y: 0, width: 100, height: 100 } })]);
    const impl = page([element({ rect: { x: 30, y: 0, width: 100, height: 100 } })]);
    const result = diffPages(design, impl);
    expect(result.diffs).toHaveLength(1);
    expect(result.diffs[0]!.severity).toBe("major");
  });

  it("flags background color deviations beyond the ΔE threshold", () => {
    nextId = 1;
    const design = page([element({ rect: { x: 0, y: 0, width: 100, height: 100 }, styles: { backgroundColor: "#333333" } })]);
    const impl = page([element({ rect: { x: 0, y: 0, width: 100, height: 100 }, styles: { backgroundColor: "#666666" } })]);
    const result = diffPages(design, impl);
    expect(result.diffs).toHaveLength(1);
    expect(result.diffs[0]!.colorIssues).toEqual([
      expect.objectContaining({ property: "backgroundColor", expected: "#333333", actual: "#666666" }),
    ]);
  });

  it("ignores imperceptible color jitter below the ΔE threshold", () => {
    nextId = 1;
    const design = page([element({ rect: { x: 0, y: 0, width: 100, height: 100 }, styles: { backgroundColor: "#333333" } })]);
    const impl = page([element({ rect: { x: 0, y: 0, width: 100, height: 100 }, styles: { backgroundColor: "#343434" } })]);
    const result = diffPages(design, impl);
    expect(result.diffs).toEqual([]);
  });

  it("reports font deviations only for text elements", () => {
    nextId = 1;
    const design = page([element({ text: "价格", rect: { x: 0, y: 0, width: 80, height: 24 }, styles: { fontSize: 14, fontWeight: "400" } })]);
    const impl = page([element({ text: "价格", rect: { x: 0, y: 0, width: 80, height: 24 }, styles: { fontSize: 16, fontWeight: "700" } })]);
    const result = diffPages(design, impl);
    expect(result.diffs).toHaveLength(1);
    expect(result.diffs[0]!.fontIssues).toEqual([
      { property: "fontSize", expected: "14", actual: "16" },
      { property: "fontWeight", expected: "400", actual: "700" },
    ]);
  });

  it("lists unmatched elements as missing or extra", () => {
    nextId = 1;
    const design = page([element({ text: "A", rect: { x: 0, y: 0, width: 50, height: 50 } })]);
    const impl = page([element({ text: "B", rect: { x: 600, y: 600, width: 50, height: 50 } })]);
    const result = diffPages(design, impl);
    expect(result.diffs).toEqual([]);
    expect(result.missing.map((item) => item.label)).toEqual([expect.stringContaining("A")]);
    expect(result.extra.map((item) => item.label)).toEqual([expect.stringContaining("B")]);
  });

  it("reports changed text for spatially matched elements", () => {
    const design = page([element({ tag: "button", text: "提交", rect: { x: 10, y: 10, width: 80, height: 32 } })]);
    const implementation = page([element({ tag: "button", text: "取消", rect: { x: 10, y: 10, width: 80, height: 32 } })]);
    const result = diffPages(design, implementation);
    expect(result.diffs).toHaveLength(1);
    expect(result.diffs[0]?.textIssue).toEqual({ expected: "提交", actual: "取消" });
  });

  it("reports image/content type changes", () => {
    const design = page([element({ tag: "div", hasImage: true, rect: { x: 10, y: 10, width: 80, height: 80 } })]);
    const implementation = page([element({ tag: "div", hasImage: false, styles: { backgroundColor: "#ffffff" }, rect: { x: 10, y: 10, width: 80, height: 80 } })]);
    const result = diffPages(design, implementation);
    expect(result.diffs[0]?.imageIssue).toEqual({ expected: true, actual: false });
  });

  it("normalizes raw colors before comparing", () => {
    nextId = 1;
    const design = page([element({ rect: { x: 0, y: 0, width: 10, height: 10 }, styles: { color: "rgb(255,0,0)" } })]);
    const impl = page([element({ rect: { x: 0, y: 0, width: 10, height: 10 }, styles: { color: "#ff0000" } })]);
    const result = diffPages(design, impl);
    expect(result.diffs).toEqual([]);
  });
});
