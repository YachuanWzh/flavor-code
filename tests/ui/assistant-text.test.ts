import React from "react";
import { renderToString } from "ink";
import { expect, it } from "vitest";

import { AssistantText } from "../../src/ui/assistant-text.js";

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
