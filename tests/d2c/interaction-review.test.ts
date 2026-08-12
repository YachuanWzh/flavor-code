import { describe, expect, it } from "vitest";

import { buildD2cAutonomousPlanPrompt, mergeInteractionManifests, parseD2cAutonomousPlanResponse } from "../../src/d2c/interaction-review.js";
import { parseInteractionManifest } from "../../src/d2c/interaction.js";

const manifest = {
  schemaVersion: 1, product: "console", deterministic: true,
  pages: [{ url: "index.html", requireApi: false, scenarios: [{ id: "open-menu", requireApi: false, steps: [
    { action: "click", selector: "#menu" }, { expect: "visible", selector: "#submenu" },
  ] }] }],
};

describe("D2C autonomous interaction reviewer", () => {
  it("builds a multimodal planning prompt without assuming one page type", () => {
    const prompt = buildD2cAutonomousPlanPrompt({ task: "console", seed: parseInteractionManifest(JSON.stringify(manifest)),
      observations: [{ url: "index.html", title: "控制台", viewport: { width: 1280, height: 800 }, headings: ["概览"],
        bodyText: "查询 新建", elements: [{ selector: "#menu", tag: "button", text: "菜单", visible: true, disabled: false }], screenshot: Buffer.from("png") }],
    });
    expect(prompt).toContain("表单、查询列表、管理后台、大屏");
    expect(prompt).toContain("一级/二级/三级菜单");
    expect(prompt).toContain("完整用户旅程");
  });

  it("parses a bounded plan and rejects shallow or escaped journeys", () => {
    const raw = JSON.stringify({ summary: "覆盖导航", pageAnalyses: [{ url: "index.html", pageType: "后台", goals: ["打开菜单"], risks: [] }], manifest });
    expect(parseD2cAutonomousPlanResponse(raw, { model: "vision", observedPages: ["index.html"], now: new Date("2026-08-12T00:00:00Z") }))
      .toMatchObject({ schema: 1, model: "vision", manifest: { pages: [{ url: "index.html" }] } });
    const shallow = structuredClone(manifest); shallow.pages[0]!.scenarios[0]!.steps = [{ expect: "visible", selector: "main" }] as never;
    expect(() => parseD2cAutonomousPlanResponse(JSON.stringify({ summary: "浅层", pageAnalyses: [{ url: "index.html", pageType: "后台", goals: ["查看"], risks: [] }], manifest: shallow }),
      { model: "vision", observedPages: ["index.html"] })).toThrow(/actions|evidence/i);
    expect(() => parseD2cAutonomousPlanResponse(raw, { model: "vision", observedPages: ["other.html"] })).toThrow(/page/i);
  });

  it("keeps the approved design contract while adding model-discovered journeys", () => {
    const seed = parseInteractionManifest(JSON.stringify(manifest));
    const autonomous = parseInteractionManifest(JSON.stringify({ ...manifest, pages: [{ ...manifest.pages[0], scenarios: [
      ...manifest.pages[0]!.scenarios,
      { id: "fill-and-submit", requireApi: true, steps: [
        { action: "fill", selector: "#name", value: "张三" },
        { action: "click", selector: "#submit" },
        { expect: "visible", selector: "#success" },
      ] },
    ] }] }));
    const merged = mergeInteractionManifests(seed, autonomous);
    expect(merged.pages[0]?.scenarios.map((scenario) => scenario.id)).toEqual(["open-menu", "fill-and-submit"]);
  });
});
