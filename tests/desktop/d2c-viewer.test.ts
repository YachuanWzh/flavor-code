import { describe, expect, it, vi } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { D2cViewer, d2cReportViewPolicy, dispatchD2cTask, importAndDispatchD2cTask, resultPresentation, shouldDeferD2cProductReview, shouldStartD2cProductPreview } from "../../src/desktop/renderer/d2c-viewer.js";
import { applyD2cAgentProgress, createD2cPendingTask } from "../../src/desktop/renderer/d2c-progress.js";

describe("dispatchD2cTask", () => {
  it("records a pending task only after submit succeeds", async () => {
    const launch = vi.fn();
    await expect(dispatchD2cTask("prompt", "homepage", "vue", async () => true, launch)).resolves.toBe(true);
    expect(launch).toHaveBeenCalledWith("homepage", "vue");
  });

  it("does not record a pending task when submit fails", async () => {
    const launch = vi.fn();
    await expect(dispatchD2cTask("prompt", "homepage", "react", async () => false, launch)).resolves.toBe(false);
    expect(launch).not.toHaveBeenCalled();
  });
});

describe("D2C pending workbench", () => {
  it("renders real activity, elapsed context and task controls without a fake percentage", () => {
    const pending = applyD2cAgentProgress(createD2cPendingTask("homepage", "vue", Date.now() - 5_000), {
      type: "tool-start", id: "write-1", name: "Write", input: {}, label: "App.vue",
    });
    const html = renderToStaticMarkup(React.createElement(D2cViewer, {
      onClose: vi.fn(), onInterrupt: vi.fn(), onError: vi.fn(), refreshKey: 0,
      onStartTask: async () => true, pending, onLaunch: vi.fn(), disabled: true,
    }));

    expect(html).toContain("实时执行轨迹");
    expect(html).toContain("创建 App.vue");
    expect(html).toContain("停止任务");
    expect(html).toContain("最近更新");
    expect(html).not.toMatch(/\d+%/);
  });
});

describe("importAndDispatchD2cTask", () => {
  it("starts D2C immediately after an HTML export is imported", async () => {
    const submit = vi.fn(async (_prompt: string) => true);
    const launch = vi.fn();
    const imported = {
      task: "homepage", entryHtml: "index.html", files: ["index.html", "analytics.html", "assets/app.css"],
      pages: [{ id: "index", label: "概览", html: "index.html" }, { id: "analytics", label: "分析", html: "analytics.html" }],
    };

    await expect(importAndDispatchD2cTask("homepage", "react", async () => imported, submit, launch)).resolves.toBe(true);
    expect(submit).toHaveBeenCalledOnce();
    const prompt = submit.mock.calls[0]![0];
    expect(prompt).toContain("React");
    expect(prompt).toContain("index.html");
    expect(prompt).toContain("analytics.html");
    expect(prompt).toContain("同名 HTML 入口");
    expect(prompt).toContain("首次有效报告生成后立即停止");
    expect(prompt).toContain("等待用户在 D2C 审阅面板逐条通过或退回");
    expect(prompt).toContain("d2c.modules.json");
    expect(prompt).toContain("data-d2c-module");
    expect(prompt).toContain("data-d2c-source");
    expect(prompt).not.toContain("持续调用 D2cCompare 并迭代修复");
    expect(prompt).toContain("不要读取工作区外的 npm 源码或缓存日志");
    expect(prompt).toContain("不要用 Shell 手动执行 npm run dev");
    expect(prompt).toContain("由它负责安装依赖、启动、探活和关闭服务器");
    expect(prompt).toContain("同一个 D2cCompare 错误连续出现时禁止原样重试");
    expect(launch).toHaveBeenCalledWith("homepage", "react");
  });

  it("does not dispatch when the directory picker is cancelled", async () => {
    const submit = vi.fn(async (_prompt: string) => true);
    const launch = vi.fn();
    await expect(importAndDispatchD2cTask("homepage", "vue", async () => undefined, submit, launch)).resolves.toBe(false);
    expect(submit).not.toHaveBeenCalled();
    expect(launch).not.toHaveBeenCalled();
  });
});

describe("resultPresentation", () => {
  it("shows invalid reports as implementation error evidence, never as a visual comparison", () => {
    expect(d2cReportViewPolicy("invalid")).toEqual({
      defaultMode: "implementation",
      modes: ["implementation", "design"],
      showComparison: false,
    });
    expect(d2cReportViewPolicy("valid")).toMatchObject({ defaultMode: "overlay", showComparison: true });
  });

  it("never presents an invalid raw similarity as an official score", () => {
    expect(resultPresentation({ total: 100, status: "invalid", confidence: "low" })).toEqual({
      primary: "—", label: "评测未完成", showConfidence: false,
    });
    expect(resultPresentation({ total: 96.8, status: "valid", confidence: "high" })).toEqual({
      primary: "96.8", label: "有效评分", showConfidence: true,
    });
  });

  it("lets uncertain mappings confirm the suggested operation or select any operation", async () => {
    const source = await import("node:fs/promises").then(({ readFile }) =>
      readFile(new URL("../../src/desktop/renderer/d2c-viewer.tsx", import.meta.url), "utf8"));
    expect(source).toContain("integration.document.operations.map");
    expect(source).toContain("确认此映射");
  });

  it("keeps the review inspector available in narrow workbench containers", async () => {
    const css = await import("node:fs/promises").then(({ readFile }) =>
      readFile(new URL("../../src/desktop/renderer/styles.css", import.meta.url), "utf8"));
    const narrow = css.slice(css.indexOf("@container (max-width: 680px)"));
    expect(narrow).toContain("grid-template-rows: minmax(240px, 1fr) minmax(300px, 46%)");
    expect(narrow).toContain(".d2c-v2 .d2c-inspector { display: block");
    expect(narrow).not.toContain(".d2c-v2 .d2c-inspector { display: none");
  });

  it("makes the running project the primary interactive canvas with safe manual controls", async () => {
    const source = await import("node:fs/promises").then(({ readFile }) =>
      readFile(new URL("../../src/desktop/renderer/d2c-viewer.tsx", import.meta.url), "utf8"));
    expect(source).toContain("<InteractiveDesktopPreview");
    expect(source).toContain("width={PRODUCT_PREVIEW_VIEWPORT.width}");
    expect(source).toContain("height={PRODUCT_PREVIEW_VIEWPORT.height}");
    expect(source).toContain("d2c-live-desktop");
    expect(source).toContain('sandbox="allow-scripts allow-forms allow-modals allow-same-origin"');
    expect(source).toContain("openD2cPreview");
    expect(source).toContain("确认人工验收通过");
    expect(source).toContain("自动与人工验收未通过时，评分只用于诊断");
    expect(source).toContain('disabled={judgeBusy || !previewStatus.running || bundle.workflow.interaction?.automated === undefined}');
    expect(source).toContain("验收失败也可以评分诊断");
  });

  it("exposes automated scenario results and observed API traffic", async () => {
    const source = await import("node:fs/promises").then(({ readFile }) =>
      readFile(new URL("../../src/desktop/renderer/d2c-viewer.tsx", import.meta.url), "utf8"));
    expect(source).toContain("runD2cInteractionTests");
    expect(source).toContain("interactionRun.apiRequestCount");
    expect(source).toContain("scenario.failure");
  });

  it("exposes an independent multimodal judge configuration and final quality gate", async () => {
    const source = await import("node:fs/promises").then(({ readFile }) =>
      readFile(new URL("../../src/desktop/renderer/d2c-viewer.tsx", import.meta.url), "utf8"));
    expect(source).toContain("getD2cJudgeConfig");
    expect(source).toContain("saveD2cJudgeConfig");
    expect(source).toContain("runD2cQualityJudge");
    expect(source).toContain("最终质量门");
    expect(source).toContain("视觉质量");
    expect(source).toContain("交互质量");
    expect(source).toContain("综合得分");
  });

  it("adds requirement, PRD and interactive design gates without removing the existing Pixso entry", async () => {
    const source = await import("node:fs/promises").then(({ readFile }) =>
      readFile(new URL("../../src/desktop/renderer/d2c-viewer.tsx", import.meta.url), "utf8"));
    expect(source).toContain("createD2cProduct");
    expect(source).toContain("确认 PRD，生成交互稿");
    expect(source).toContain("确认设计，进入 D2C 视觉还原");
    expect(source).toContain("交互契约未通过预检");
    expect(source).toContain("自动修复清单");
    expect(source).toContain("productView.validationError");
    expect(source).toContain("正在可视化回放");
    expect(source).toContain("请观察左侧页面");
    expect(source).toContain("多模态模型正在观察并规划用户旅程");
    expect(source).toContain("自主审阅已执行");
    expect(source).toContain("自主规划失败，已执行设计契约");
    expect(source).toContain("interactionReview.warning");
    expect(source).toContain("d2c-product-preview");
    expect(source.match(/sandbox="allow-scripts allow-forms allow-modals allow-same-origin"/g)).toHaveLength(2);
    expect(source).toContain("导入 HTML，从 D2C 视觉还原开始");
  });

  it("renders prototypes in a scaled desktop viewport instead of collapsing the page into a narrow iframe", async () => {
    const source = await import("node:fs/promises").then(({ readFile }) =>
      readFile(new URL("../../src/desktop/renderer/d2c-viewer.tsx", import.meta.url), "utf8"));
    expect(source).toContain("PRODUCT_PREVIEW_VIEWPORT");
    expect(source).toContain("new ResizeObserver");
    expect(source).toContain("d2c-product-preview-canvas");
    expect(source).toContain("1280 × 800");
    expect(source).toContain("d2c-start-screen-product");
  });
});

describe("E2E product artifact presentation gate", () => {
  it("keeps newly written PRD and prototype artifacts in generating state while the owning session is busy", () => {
    expect(shouldDeferD2cProductReview(undefined, "prd-review", true)).toBe(true);
    expect(shouldDeferD2cProductReview("prd-generating", "prd-review", true)).toBe(true);
    expect(shouldDeferD2cProductReview("design-generating", "design-review", true)).toBe(true);
  });

  it("reveals review artifacts after the session ends and does not hide an already visible review", () => {
    expect(shouldDeferD2cProductReview("design-generating", "design-review", false)).toBe(false);
    expect(shouldDeferD2cProductReview("design-review", "design-review", true)).toBe(false);
    expect(shouldDeferD2cProductReview("design-review", "ready-for-d2c", true)).toBe(false);
  });

  it("starts the preview server only after the session ends", () => {
    expect(shouldStartD2cProductPreview("design-review", true, false)).toBe(false);
    expect(shouldStartD2cProductPreview("design-review", false, false)).toBe(true);
    expect(shouldStartD2cProductPreview("design-generating", false, false)).toBe(false);
    expect(shouldStartD2cProductPreview("design-review", false, true)).toBe(false);
  });
});
