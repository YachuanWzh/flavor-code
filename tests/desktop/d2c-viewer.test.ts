import { describe, expect, it, vi } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { D2cViewer, d2cReportViewPolicy, dispatchD2cTask, importAndDispatchD2cTask, resultPresentation } from "../../src/desktop/renderer/d2c-viewer.js";
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
    expect(source).toContain("<iframe key={previewReloadKey}");
    expect(source).toContain('sandbox="allow-scripts allow-forms allow-modals allow-same-origin"');
    expect(source).toContain("openD2cPreview");
    expect(source).toContain("确认人工验收通过");
  });

  it("exposes automated scenario results and observed API traffic", async () => {
    const source = await import("node:fs/promises").then(({ readFile }) =>
      readFile(new URL("../../src/desktop/renderer/d2c-viewer.tsx", import.meta.url), "utf8"));
    expect(source).toContain("runD2cInteractionTests");
    expect(source).toContain("interactionRun.apiRequestCount");
    expect(source).toContain("scenario.failure");
  });
});
