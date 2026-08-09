import { describe, expect, it } from "vitest";

import { diffPages } from "../../src/d2c/diff.js";
import { buildReport, summarizeReport } from "../../src/d2c/report.js";
import type { D2cElementSnapshot, D2cPageSnapshot, D2cRect } from "../../src/d2c/types.js";

let nextId = 1;
function element(overrides: Partial<D2cElementSnapshot> & { rect: D2cRect }): D2cElementSnapshot {
  return { id: nextId++, tag: "div", text: "", styles: {}, hasImage: false, ...overrides };
}
function page(elements: D2cElementSnapshot[], width = 1440, height = 900): D2cPageSnapshot {
  return { width, height, elements };
}

describe("buildReport", () => {
  it("assembles scores, diffs and unmatched elements with stable metadata", () => {
    nextId = 1;
    const design = page([
      element({ text: "标题", rect: { x: 100, y: 100, width: 200, height: 40 } }),
      element({ text: "缺失块", rect: { x: 400, y: 400, width: 60, height: 60 } }),
    ]);
    const impl = page([element({ text: "标题", rect: { x: 105, y: 100, width: 200, height: 40 } })]);
    const report = buildReport({
      task: "homepage",
      reportId: "run-test",
      createdAt: new Date("2026-08-09T12:00:00Z"),
      design: { source: "design/index.html", snapshot: design },
      implementation: { source: "http://127.0.0.1:5173/", snapshot: impl },
      pixelMismatchRate: 0.02,
    });
    expect(report.schema).toBe(1);
    expect(report.task).toBe("homepage");
    expect(report.reportId).toBe("run-test");
    expect(report.design.elementCount).toBe(2);
    expect(report.implementation.elementCount).toBe(1);
    expect(report.diffs).toHaveLength(1);
    expect(report.diffs[0]!.dx).toBe(5);
    expect(report.missing).toHaveLength(1);
    expect(report.extra).toEqual([]);
    expect(report.scores.pixel).toBeCloseTo(0.98, 5);
    expect(report.scores.total).toBeGreaterThan(0);
  });
});

describe("summarizeReport", () => {
  it("renders the total score, grade, top issues with px offsets and color pairs", () => {
    nextId = 1;
    const design = page([
      element({ text: "标题", rect: { x: 100, y: 100, width: 200, height: 40 } }),
      element({ rect: { x: 0, y: 0, width: 50, height: 50 }, styles: { backgroundColor: "#333333" } }),
      element({ text: "缺失", rect: { x: 400, y: 400, width: 60, height: 60 } }),
    ]);
    const impl = page([
      element({ text: "标题", rect: { x: 103, y: 100, width: 200, height: 40 } }),
      element({ rect: { x: 0, y: 0, width: 50, height: 50 }, styles: { backgroundColor: "#666666" } }),
    ]);
    const report = buildReport({
      task: "homepage",
      reportId: "run-test",
      createdAt: new Date("2026-08-09T12:00:00Z"),
      design: { source: "design/index.html", snapshot: design },
      implementation: { source: "dist/index.html", snapshot: impl },
      pixelMismatchRate: 0,
    });
    const summary = summarizeReport(report);
    expect(summary).toContain("homepage");
    expect(summary).toContain(String(report.scores.total));
    expect(summary).toContain(report.scores.grade);
    expect(summary).toContain("3px");
    expect(summary).toContain("#333333");
    expect(summary).toContain("#666666");
    expect(summary).toContain("缺失");
  });

  it("limits the issue list to the requested top N", () => {
    nextId = 1;
    const elements = Array.from({ length: 10 }, (_, index) =>
      element({ rect: { x: index * 100, y: 0, width: 80, height: 40 } }));
    const shifted = Array.from({ length: 10 }, (_, index) =>
      element({ rect: { x: index * 100 + 20, y: 0, width: 80, height: 40 } }));
    const design = page(elements);
    const report = buildReport({
      task: "grid",
      reportId: "run-test",
      createdAt: new Date(),
      design: { source: "d", snapshot: design },
      implementation: { source: "i", snapshot: page(shifted) },
      pixelMismatchRate: 0.1,
    });
    const summary = summarizeReport(report, 3);
    const issueLines = summary.split("\n").filter((line) => /^\d+\./.test(line.trim()));
    expect(issueLines).toHaveLength(3);
    expect(summary).toContain("10");
  });
});
