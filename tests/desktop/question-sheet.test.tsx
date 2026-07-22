import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { MemoryReviewRail, QuestionSheet } from "../../src/desktop/renderer/app.js";

describe("desktop user confirmation surfaces", () => {
  it("appends a custom-input choice after the agent-provided AskUser options", () => {
    const html = renderToStaticMarkup(<QuestionSheet questions={[{
      header: "Approach",
      question: "Which approach?",
      options: [{ label: "A", description: "Approach A" }, { label: "B", description: "Approach B" }],
    }]} onAnswer={vi.fn()} />);

    expect(html.indexOf("Approach A")).toBeLessThan(html.indexOf("其他（自定义输入）"));
    expect(html).toContain("键入你自己的回答");
  });

  it("renders memory confirmation as a non-modal review rail", () => {
    const html = renderToStaticMarkup(<MemoryReviewRail reviews={[
      { id: "memory-review-1", type: "project", content: "Use pnpm." },
    ]} onResolve={vi.fn()} />);

    expect(html).toContain("memory-review-rail");
    expect(html).not.toContain("aria-modal");
    expect(html).toContain("确认前不会写入长期记忆");
    expect(html).toContain("Use pnpm.");
  });
});
