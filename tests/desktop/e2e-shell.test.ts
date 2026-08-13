import { readFile } from "node:fs/promises";

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { E2eViewer as D2cE2eViewer } from "../../src/desktop/renderer/d2c-viewer.js";
import { E2eViewer } from "../../src/desktop/renderer/e2e-viewer.js";

function renderE2eShell(): string {
  return renderToStaticMarkup(React.createElement(E2eViewer, {
    onClose: vi.fn(), onInterrupt: vi.fn(), onError: vi.fn(), refreshKey: 0,
    onStartTask: async () => true, pending: undefined, onLaunch: vi.fn(), disabled: false,
  }));
}

describe("Electron E2E delivery shell", () => {
  it("renders E2E as the top-level workspace and D2C as the visual-fidelity module", () => {
    const html = renderE2eShell();
    expect(html).toContain('aria-label="E2E 端到端交付"');
    expect(html).toContain("END-TO-END DELIVERY");
    expect(html).toContain("<h1>E2E</h1>");
    expect(html).toContain("D2C · 视觉还原");
  });

  it("renders the seven-stage pipeline from requirement to delivery", () => {
    const html = renderE2eShell();
    expect(html).toContain('aria-label="E2E 从需求到成果物流程"');
    for (const stage of ["需求", "PRD", "交互设计", "D2C", "API 联调", "自主验收", "成果交付"]) {
      expect(html).toContain(stage);
    }
  });

  it("exposes E2eViewer through the facade and keeps the D2C component export compatible", () => {
    expect(typeof E2eViewer).toBe("function");
    expect(E2eViewer).toBe(D2cE2eViewer);
  });

  it("offers requirement and existing-design entries with an automatic Vue + Python default", () => {
    const html = renderE2eShell();
    expect(html).toContain("从需求开始");
    expect(html).toContain("已有设计稿");
    expect(html).toContain("Vue 3 + Python");
    expect(html).toContain("真实后端联调");
    expect(html).toContain("生成 PRD");
  });

  it("routes the E2E view through the app shell onto the D2C prompt channel", async () => {
    const app = await readFile(new URL("../../src/desktop/renderer/app.tsx", import.meta.url), "utf8");
    expect(app).toContain('view === "e2e"');
    expect(app).toContain('setView("e2e")');
    expect(app).toContain("<span>E2E</span>");
    expect(app).toContain("<E2eViewer");
    expect(app).toContain('send(prompt, "prompt", "d2c")');
  });

  it("styles the requirement composer without browser-default textarea chrome", async () => {
    const css = await readFile(new URL("../../src/desktop/renderer/styles.css", import.meta.url), "utf8");
    expect(css).toContain(".d2c-start-field input, .d2c-start-field textarea");
    expect(css).toContain(".d2c-requirement-field:focus-within");
    expect(css).toContain(".d2c-requirement-field textarea::placeholder");
    expect(css).toContain("font-family: \"Microsoft YaHei UI\"");
  });

  it("auto-prepares the API contract for requirement delivery and keeps upload as an override", async () => {
    const source = await readFile(new URL("../../src/desktop/renderer/d2c-viewer.tsx", import.meta.url), "utf8");
    expect(source).toContain('bundle.deliveryOrigin === "requirement"');
    expect(source).toContain("正在根据 PRD 与模块准备 OpenAPI 契约");
    expect(source).toContain("接入已有 Swagger / OpenAPI");
  });
});
