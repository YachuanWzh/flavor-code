import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { ModelMenu } from "../../src/desktop/renderer/app.js";
import { DEFAULT_DESKTOP_MODELS } from "../../src/desktop/model-config.js";

describe("desktop model menu", () => {
  it("renders the DeepSeek defaults, custom models and marks the active one", () => {
    const output = renderToStaticMarkup(<ModelMenu
      models={[...DEFAULT_DESKTOP_MODELS, {
        id: "siliconflow:qwen3-coder", provider: "siliconflow", model: "qwen3-coder",
        label: "qwen3-coder", description: "siliconflow · OpenAI 兼容 API", source: "custom",
      }]}
      activeModel="anthropic:deepseek-v4-pro"
      busy={false}
      onSelect={vi.fn()}
      onAdd={vi.fn(async () => undefined)}
    />);

    expect(output).toContain("DeepSeek V4 Pro");
    expect(output).toContain("DeepSeek V4 Flash");
    expect(output).toContain("deepseek-v4-pro⌄");
    expect(output).toContain('aria-selected="true"');
    expect(output).toContain("qwen3-coder");
    expect(output).toContain("自定义");
    expect(output).toContain("新增");
  });
});
