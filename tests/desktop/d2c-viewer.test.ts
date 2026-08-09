import { describe, expect, it, vi } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { D2cViewer, dispatchD2cTask, importAndDispatchD2cTask, resultPresentation } from "../../src/desktop/renderer/d2c-viewer.js";
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
    expect(submit.mock.calls[0]![0]).toContain("React");
    expect(submit.mock.calls[0]![0]).toContain("index.html");
    expect(submit.mock.calls[0]![0]).toContain("analytics.html");
    expect(submit.mock.calls[0]![0]).toContain("同名 HTML 入口");
    expect(submit.mock.calls[0]![0]).toContain("最多调用 3 次 D2cCompare");
    expect(submit.mock.calls[0]![0]).toContain("不要读取工作区外的 npm 源码或缓存日志");
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
  it("never presents an invalid raw similarity as an official score", () => {
    expect(resultPresentation({ total: 100, status: "invalid", confidence: "low" })).toEqual({
      primary: "—", label: "评测未完成", diagnostic: "已采集区域相似度 100.0", showConfidence: false,
    });
    expect(resultPresentation({ total: 96.8, status: "valid", confidence: "high" })).toEqual({
      primary: "96.8", label: "有效评分", showConfidence: true,
    });
  });
});
