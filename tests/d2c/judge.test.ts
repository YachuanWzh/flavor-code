import { describe, expect, it } from "vitest";

import {
  buildD2cJudgePrompt,
  finalizeD2cQualityJudgment,
  parseD2cJudgeModelResponse,
} from "../../src/d2c/judge.js";
import type { D2cInteractionRun } from "../../src/d2c/interaction.js";
import type { D2cReport } from "../../src/d2c/types.js";

const report = {
  schema: 2, task: "checkout", reportId: "run-20260812-010203", createdAt: "2026-08-12T01:02:03.000Z",
  design: { source: "design/index.html", width: 1280, height: 800, elementCount: 10 },
  implementation: { source: "src/d2c-output/checkout", width: 1280, height: 800, elementCount: 10 },
  scores: { layout: .9, color: .92, typography: .95, content: 1, pixel: .88, total: 91, grade: "优秀" },
  evaluation: { status: "valid", confidence: "high", verdict: "conditional", summary: "仍有轻微差异", checks: [] },
  diffs: [], missing: [], extra: [], pixelMismatchRate: .12,
} satisfies D2cReport;

const interaction = {
  schema: 1, runAt: "2026-08-12T02:00:00.000Z", baseUrl: "http://127.0.0.1:5173/",
  passed: true, total: 2, failures: 0, apiRequestCount: 3,
  scenarios: [
    { id: "fill-form", pageUrl: "http://127.0.0.1:5173/", passed: true, durationMs: 120, apiRequestCount: 1 },
    { id: "submit-form", pageUrl: "http://127.0.0.1:5173/", passed: true, durationMs: 180, apiRequestCount: 2 },
  ],
} satisfies D2cInteractionRun;

describe("D2C multimodal quality judge", () => {
  it("parses strict JSON responses and strips a single markdown fence", () => {
    const assessment = parseD2cJudgeModelResponse(`\`\`\`json\n${JSON.stringify({
      visualScore: 93, interactionScore: 88, confidence: "high", summary: "整体可靠",
      strengths: ["层级清晰"], issues: [{ category: "interaction", severity: "minor", description: "错误提示略弱", recommendation: "增加字段级提示" }],
    })}\n\`\`\``);
    expect(assessment).toMatchObject({ visualScore: 93, interactionScore: 88, confidence: "high" });
  });

  it("computes the final score locally and enforces threshold and critical gates", () => {
    const passed = finalizeD2cQualityJudgment({
      assessment: { visualScore: 90, interactionScore: 90, confidence: "high", summary: "通过", strengths: [], issues: [] },
      report, interaction, model: "vision-pro", passThreshold: 80, now: new Date("2026-08-12T03:00:00.000Z"),
    });
    expect(passed.overallScore).toBe(91.2);
    expect(passed.verdict).toBe("pass");

    const blocked = finalizeD2cQualityJudgment({
      assessment: { visualScore: 99, interactionScore: 99, confidence: "high", summary: "存在关键问题", strengths: [],
        issues: [{ category: "interaction", severity: "critical", description: "提交按钮无响应", recommendation: "修复提交事件" }] },
      report, interaction, model: "vision-pro", passThreshold: 80,
    });
    expect(blocked.verdict).toBe("fail");
  });

  it("never lets an LLM score override failed deterministic interaction evidence", () => {
    const failedInteraction: D2cInteractionRun = { ...interaction, passed: false, failures: 1 };
    const result = finalizeD2cQualityJudgment({
      assessment: { visualScore: 100, interactionScore: 100, confidence: "high", summary: "模型误判", strengths: [], issues: [] },
      report, interaction: failedInteraction, model: "vision-pro", passThreshold: 80,
    });
    expect(result.verdict).toBe("fail");
    expect(result.deterministicInteractionPassed).toBe(false);
  });

  it("builds a bounded evidence prompt without configuration secrets", () => {
    const prompt = buildD2cJudgePrompt({ report, interaction });
    expect(prompt).toContain("视觉还原质量");
    expect(prompt).toContain("表单与交互质量");
    expect(prompt).toContain("91");
    expect(prompt).toContain("fill-form");
    expect(prompt).not.toMatch(/apiKey|authorization|sk-secret/i);
  });
});
