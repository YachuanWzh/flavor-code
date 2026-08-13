import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  applyInteractionRun,
  applyManualInteractionDecision,
  applyQualityIssueDecision,
  applyQualityJudgment,
  applyReviewDecision,
  buildD2cInteractionRepairPrompt,
  buildD2cRepairPrompt,
  createWorkflow,
  readWorkflow,
  reconcileWorkflow,
  reviewProgress,
  writeWorkflow,
} from "../../src/d2c/workflow.js";
import type { D2cInteractionRun } from "../../src/d2c/interaction.js";
import { finalizeD2cQualityJudgment } from "../../src/d2c/judge.js";
import type { D2cReport } from "../../src/d2c/types.js";

const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))));

function report(reportId = "run-20260810-010203", dx = 8): D2cReport {
  return {
    schema: 2, task: "dashboard", reportId, createdAt: "2026-08-10T01:02:03.000Z",
    design: { source: "design/index.html", width: 100, height: 100, elementCount: 1, designHash: "a".repeat(64) },
    implementation: { source: "src/d2c-output/dashboard", width: 100, height: 100, elementCount: 1 },
    scores: { layout: .8, color: 1, typography: 1, content: 1, pixel: .9, total: 91, grade: "优秀" },
    evaluation: { status: "valid", confidence: "high", verdict: "conditional", summary: "有差异", checks: [] },
    diffs: [{
      designId: 1, implId: 1, label: "统计卡片", designRect: { x: 0, y: 0, width: 40, height: 20 },
      implRect: { x: dx, y: 0, width: 40, height: 20 }, dx, dy: 0, dw: 0, dh: 0,
      colorIssues: [], fontIssues: [], severity: "major", fingerprint: "issue-card", impact: 7,
      designSelector: ".card", implementationSelector: "[data-d2c-module=stats]",
      moduleId: "stats", moduleSourceFiles: ["src/components/StatsCard.vue"],
    }],
    missing: [{ id: 2, label: "头像", rect: { x: 50, y: 0, width: 10, height: 10 }, text: "", hasImage: true,
      selector: ".avatar", fingerprint: "issue-avatar", impact: 8, severity: "major", moduleId: "profile",
      moduleSourceFiles: ["src/components/Profile.vue"] }], extra: [], pixelMismatchRate: .1,
  };
}

describe("D2C review workflow", () => {
  it("starts every current issue as pending and reports progress", () => {
    const workflow = createWorkflow(report(), "vue");
    expect(workflow.stage).toBe("visual-review");
    expect(workflow.reviews.map((item) => item.decision)).toEqual(["pending", "pending"]);
    expect(reviewProgress(workflow)).toEqual({ total: 2, pending: 2, accepted: 0, needsFix: 0, complete: false });
  });

  it("supports one issue and bulk decisions, entering API mapping only after all are accepted", () => {
    let workflow = createWorkflow(report(), "vue");
    workflow = applyReviewDecision(workflow, { fingerprints: ["issue-card"], decision: "accepted" }, report());
    expect(workflow.stage).toBe("visual-review");
    workflow = applyReviewDecision(workflow, { fingerprints: ["issue-avatar"], decision: "accepted" }, report());
    expect(workflow.stage).toBe("api-mapping");
    expect(reviewProgress(workflow).complete).toBe(true);
  });

  it("keeps rejected instructions and returns to review", () => {
    const workflow = applyReviewDecision(createWorkflow(report(), "react"), {
      fingerprints: ["issue-card"], decision: "needs-fix", instruction: "卡片再紧凑一些",
    }, report());
    expect(workflow.reviews.find((item) => item.fingerprint === "issue-card")).toMatchObject({
      decision: "needs-fix", instruction: "卡片再紧凑一些",
    });
    expect(workflow.stage).toBe("visual-review");
  });

  it("does not allow invalid evidence to be accepted", () => {
    const invalid = report();
    invalid.evaluation.status = "invalid";
    expect(() => applyReviewDecision(createWorkflow(invalid, "vue"), {
      fingerprints: ["issue-card"], decision: "accepted",
    }, invalid)).toThrow(/invalid|未完成/i);
  });

  it("inherits acceptance only when the issue signature is unchanged", () => {
    let workflow = createWorkflow(report(), "vue");
    workflow = applyReviewDecision(workflow, { fingerprints: ["issue-card"], decision: "accepted" }, report());
    const same = reconcileWorkflow(workflow, report("run-20260810-020304"));
    expect(same.reviews.find((item) => item.fingerprint === "issue-card")?.decision).toBe("accepted");
    const changed = reconcileWorkflow(workflow, report("run-20260810-030405", 15));
    expect(changed.reviews.find((item) => item.fingerprint === "issue-card")?.decision).toBe("pending");
  });

  it("keeps review decisions from other pages in the same comparison batch", () => {
    const first = report();
    first.batchId = "batch-1";
    first.page = { id: "home", label: "首页", html: "index.html", index: 0, count: 2 };
    let workflow = createWorkflow(first, "vue");
    workflow = applyReviewDecision(workflow, { fingerprints: ["issue-card", "issue-avatar"], decision: "accepted" }, first);
    const second = report("run-20260810-010204");
    second.batchId = "batch-1";
    second.page = { id: "settings", label: "设置", html: "settings.html", index: 1, count: 2 };
    const reconciled = reconcileWorkflow(workflow, second);
    expect(reconciled.reviews.filter((item) => item.pageId === "home").every((item) => item.decision === "accepted")).toBe(true);
    expect(reconciled.reviews.filter((item) => item.pageId === "settings").every((item) => item.decision === "pending")).toBe(true);
    expect(reviewProgress(reconciled).complete).toBe(false);
  });

  it("persists atomically and ignores a missing workflow", async () => {
    const dir = await mkdtemp(join(tmpdir(), "flavor-d2c-workflow-")); dirs.push(dir);
    await expect(readWorkflow(dir, "dashboard")).resolves.toBeUndefined();
    await writeWorkflow(dir, createWorkflow(report(), "vue"));
    await expect(readWorkflow(dir, "dashboard")).resolves.toMatchObject({ task: "dashboard", schema: 1, revision: 1 });
  });

  it("builds a repair prompt constrained to the detected module files", () => {
    const prompt = buildD2cRepairPrompt(report(), ["issue-card"], "卡片再紧凑一些");
    expect(prompt).toContain("stats");
    expect(prompt).toContain("src/components/StatsCard.vue");
    expect(prompt).toContain("只允许修改");
    expect(prompt).toContain("卡片再紧凑一些");
    expect(prompt).toContain("D2cCompare");
  });

  it("requires automated, manual and multimodal judge acceptance before completion", () => {
    const accepted = applyReviewDecision(createWorkflow(report(), "vue"), {
      fingerprints: ["issue-card", "issue-avatar"], decision: "accepted",
    }, report());
    const run: D2cInteractionRun = {
      schema: 1, runAt: "2026-08-10T02:00:00.000Z", baseUrl: "http://127.0.0.1:4173/",
      passed: true, total: 1, failures: 0, apiRequestCount: 2,
      scenarios: [{ id: "load", pageUrl: "http://127.0.0.1:4173/", passed: true, durationMs: 12, apiRequestCount: 2 }],
    };
    const automated = applyInteractionRun({ ...accepted, stage: "integrating" }, run);
    expect(automated.stage).toBe("interaction-review");
    expect(automated.interaction).toMatchObject({ manualDecision: "pending", automated: { passed: true } });
    const readyForJudge = applyManualInteractionDecision(automated, true);
    expect(readyForJudge.stage).toBe("quality-judge");
    const complete = applyQualityJudgment(readyForJudge, {
      schema: 1, runAt: "2026-08-10T02:01:00.000Z", model: "vision-pro", visualScore: 92,
      interactionScore: 90, staticVisualScore: 91, deterministicInteractionPassed: true,
      overallScore: 91.1, threshold: 80, verdict: "pass", confidence: "high", summary: "通过", strengths: [], issues: [],
    });
    expect(complete.stage).toBe("completed");
  });

  it("returns to interaction review when a rerun fails or manual acceptance is withdrawn", () => {
    const base = { ...createWorkflow(report(), "react"), stage: "interaction-review" as const };
    const manual = applyManualInteractionDecision(base, true);
    const failed = applyInteractionRun(manual, {
      schema: 1, runAt: "2026-08-10T02:00:00.000Z", baseUrl: "http://localhost:5173/",
      passed: false, total: 1, failures: 1, apiRequestCount: 0,
      scenarios: [{ id: "submit", pageUrl: "http://localhost:5173/", passed: false, durationMs: 5, apiRequestCount: 0, failure: "No API request" }],
    });
    expect(failed.stage).toBe("interaction-review");
    expect(failed.quality).toBeUndefined();
    expect(applyManualInteractionDecision(failed, false).interaction?.manualDecision).toBe("pending");
    const diagnostic = applyQualityJudgment(failed, {
      schema: 1, runAt: "2026-08-10T02:01:00.000Z", model: "vision", visualScore: 70,
      interactionScore: 30, staticVisualScore: 91, deterministicInteractionPassed: false,
      overallScore: 50, threshold: 80, verdict: "fail", confidence: "high", summary: "交互失败", strengths: [], issues: [],
    });
    expect(diagnostic.quality).toMatchObject({ verdict: "fail", deterministicInteractionPassed: false });
    expect(diagnostic.stage).toBe("interaction-review");
  });

  it("builds a failed interaction repair prompt that preserves the acceptance contract and repairs partial seed data", () => {
    const prompt = buildD2cInteractionRepairPrompt("inventory", [{
      id: "movements-load", pageUrl: "http://127.0.0.1:4173/#/movements", passed: false,
      durationMs: 20, apiRequestCount: 1, failure: "Expected 8 rows; actual 0",
      requests: [{ method: "GET", path: "/api/movements", status: 200 }],
    }]);
    expect(prompt).toContain("movements-load");
    expect(prompt).toContain("Expected 8 rows; actual 0");
    expect(prompt).toContain("GET /api/movements");
    expect(prompt).toContain("不得修改设计稿、PRD 或 interaction-manifest.json");
    expect(prompt).toContain("按业务表独立、幂等地补齐");
    expect(prompt).toContain("请求成功不等于数据正确");
  });

  it("invalidates an old quality judgment when visual or interaction evidence changes", () => {
    const accepted = applyReviewDecision(createWorkflow(report(), "vue"), {
      fingerprints: ["issue-card", "issue-avatar"], decision: "accepted",
    }, report());
    const run: D2cInteractionRun = {
      schema: 1, runAt: "2026-08-10T02:00:00.000Z", baseUrl: "http://127.0.0.1:4173/", passed: true,
      total: 1, failures: 0, apiRequestCount: 1,
      scenarios: [{ id: "load", pageUrl: "http://127.0.0.1:4173/", passed: true, durationMs: 10, apiRequestCount: 1 }],
    };
    const ready = applyManualInteractionDecision(applyInteractionRun({ ...accepted, stage: "integrating" }, run), true);
    const judged = applyQualityJudgment(ready, {
      schema: 1, runAt: "2026-08-10T02:01:00.000Z", model: "vision", visualScore: 90, interactionScore: 90,
      staticVisualScore: 91, deterministicInteractionPassed: true, overallScore: 90, threshold: 80,
      verdict: "pass", confidence: "high", summary: "ok", strengths: [], issues: [],
    });
    expect(judged.stage).toBe("completed");
    expect(applyInteractionRun(judged, run).quality).toBeUndefined();
    expect(reconcileWorkflow(judged, report("run-20260810-030405", 15)).quality).toBeUndefined();
  });

  it("persists skip and fix decisions for final visual and interaction issues", () => {
    const quality = finalizeD2cQualityJudgment({
      assessment: { visualScore: 82, interactionScore: 85, confidence: "high", summary: "有待处理问题", strengths: [], issues: [
        { category: "visual", severity: "major", description: "卡片间距不一致", recommendation: "对齐间距", scoreImpact: 6 },
        { category: "interaction", severity: "major", description: "提交反馈不清晰", recommendation: "补充状态", scoreImpact: 5 },
      ] },
      report: report(),
      interaction: { schema: 1, runAt: "2026-08-10T02:00:00.000Z", baseUrl: "http://127.0.0.1:4173/", passed: true,
        total: 1, failures: 0, apiRequestCount: 1, scenarios: [] },
      model: "vision", passThreshold: 80,
    });
    const base = { ...createWorkflow(report(), "vue"), quality };
    const skipped = applyQualityIssueDecision(base, quality.issues[0]!.id, "skipped");
    expect(skipped.quality?.issues[0]?.decision).toBe("skipped");
    expect(skipped.quality!.visualScore).toBeGreaterThan(quality.visualScore);
    const fixing = applyQualityIssueDecision(skipped, quality.issues[1]!.id, "fixing");
    expect(fixing.quality?.issues[1]?.decision).toBe("fixing");
  });
});
