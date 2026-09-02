import React from "react";
import { renderToString } from "ink";
import { expect, it } from "vitest";

import { stringWidth } from "../../src/claude-ink/stringWidth.js";
import { AssistantText } from "../../src/ui/assistant-text.js";

const ANSI_RE = /\x1B\[[0-?]*[ -/]*[@-~]/g;

function renderPlain(text: string, columns: number): string {
  return renderToString(React.createElement(AssistantText, { text }), { columns })
    .replace(ANSI_RE, "");
}

it("renders markdown semantics without exposing markdown control markers", () => {
  const rendered = renderToString(React.createElement(AssistantText, {
    text: "# 标题\n\n**重点** and `value`\n\n```ts\nconst x = 1;\n```",
  }), { columns: 80 });
  const output = rendered.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");

  expect(output).toContain("标题");
  expect(output).toContain("重点");
  expect(output).toContain("const x = 1;");
  expect(output).not.toContain("# 标题");
  expect(output).not.toContain("**");
  expect(output).not.toContain("```");
});

it("keeps single-line code bodies visible beside a multi-line fenced block", () => {
  const rendered = renderToString(React.createElement(AssistantText, {
    text: [
      "1. **装依赖**",
      "   ```",
      "   pip install -r requirements.txt",
      "   ```",
      "",
      "2. **配置环境变量**",
      "   ```",
      "   GITLAB_WEBHOOK_SECRET=xxx",
      "   GITLAB_BASE_URL=https://gitlab.com",
      "   ```",
      "",
      "3. **启动服务**",
      "   ```",
      "   uvicorn app.main:app --host 0.0.0.0 --port 8000",
      "   ```",
    ].join("\n"),
  }), { columns: 112 });
  const output = rendered.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");

  expect(output).toContain("pip install -r requirements.txt");
  expect(output).toContain("GITLAB_WEBHOOK_SECRET=xxx");
  expect(output).toContain("uvicorn app.main:app --host 0.0.0.0 --port 8000");
});

it.each([20, 32, 80, 120])(
  "keeps list-nested fenced blocks inside a %i-column parent",
  (columns) => {
    const fence = "`".repeat(3);
    const output = renderPlain([
      "- 文档引用路径验证通过：",
      `  ${fence}text`,
      "  path-ok",
      `  ${fence}`,
      "- 陈旧项检查结果：",
      `  ${fence}json`,
      "  {ok:true}",
      `  ${fence}`,
    ].join("\n"), columns);

    expect(output).toContain("path-ok");
    expect(output).toContain("{ok:true}");
    for (const line of output.split("\n")) {
      expect(stringWidth(line)).toBeLessThanOrEqual(columns);
    }
  },
);

it("truncates a long fenced-code line instead of adding a soft-wrapped row", () => {
  const fence = "`".repeat(3);
  const output = renderPlain([
    "- result:",
    `  ${fence}text`,
    `  ${"x".repeat(200)}`,
    `  ${fence}`,
  ].join("\n"), 40);
  const codeRows = output.split("\n").filter((line) => line.includes("x"));

  expect(codeRows).toHaveLength(1);
  expect(stringWidth(codeRows[0]!)).toBeLessThanOrEqual(40);
});
