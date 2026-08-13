import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("Electron E2E delivery shell", () => {
  it("presents E2E as the top-level workspace and keeps D2C as the visual-fidelity module", async () => {
    const source = await readFile(new URL("../../src/desktop/renderer/d2c-viewer.tsx", import.meta.url), "utf8");

    expect(source).toContain('aria-label="E2E 端到端交付"');
    expect(source).toContain("END-TO-END DELIVERY");
    expect(source).toContain("<h1>E2E</h1>");
    expect(source).toContain("D2C · 视觉还原");
    expect(source).toContain('aria-label="E2E 从需求到成果物流程"');
    expect(source).toContain("API 联调");
    expect(source).toContain("自主验收");
    expect(source).toContain("成果交付");
  });

  it("uses an E2E renderer entry while retaining the D2C runtime permission profile", async () => {
    const [app, facade] = await Promise.all([
      readFile(new URL("../../src/desktop/renderer/app.tsx", import.meta.url), "utf8"),
      readFile(new URL("../../src/desktop/renderer/e2e-viewer.tsx", import.meta.url), "utf8"),
    ]);

    expect(app).toContain('view === "e2e"');
    expect(app).toContain('setView("e2e")');
    expect(app).toContain("<span>E2E</span>");
    expect(app).toContain("<E2eViewer");
    expect(app).toContain('send(prompt, "prompt", "d2c")');
    expect(facade).toContain('from "./d2c-viewer.js"');
  });

  it("styles the requirement composer without browser-default textarea chrome", async () => {
    const css = await readFile(new URL("../../src/desktop/renderer/styles.css", import.meta.url), "utf8");

    expect(css).toContain(".d2c-start-field input, .d2c-start-field textarea");
    expect(css).toContain(".d2c-requirement-field:focus-within");
    expect(css).toContain(".d2c-requirement-field textarea::placeholder");
    expect(css).toContain("font-family: \"Microsoft YaHei UI\"");
  });

  it("uses an automatic Vue and Python default for requirements while retaining the design-import selector", async () => {
    const [source, css] = await Promise.all([
      readFile(new URL("../../src/desktop/renderer/d2c-viewer.tsx", import.meta.url), "utf8"),
      readFile(new URL("../../src/desktop/renderer/styles.css", import.meta.url), "utf8"),
    ]);

    expect(source).toContain('entryMode === "design" && <fieldset className="d2c-stack-picker"');
    expect(source).toContain('className="d2c-default-stack"');
    expect(source).toContain("Vue 3 + Python");
    expect(source).toContain("真实后端联调 · 可迁移至 MySQL / PostgreSQL");
    expect(source).toContain('createD2cProduct({ task: taskName, framework: "vue", requirement })');
    expect(css).toContain(".d2c-default-stack");
  });

  it("auto-prepares the API contract for requirement delivery and keeps upload as an override", async () => {
    const source = await readFile(new URL("../../src/desktop/renderer/d2c-viewer.tsx", import.meta.url), "utf8");
    expect(source).toContain('bundle.deliveryOrigin === "requirement"');
    expect(source).toContain("正在根据 PRD 与模块准备 OpenAPI 契约");
    expect(source).toContain("接入已有 Swagger / OpenAPI");
  });
});
