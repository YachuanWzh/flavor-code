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
