import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { MemoryHeatBadge, MemoryManagerView } from "../../src/desktop/renderer/memory-manager.js";

describe("MemoryManagerView", () => {
  it("renders a focused project-memory workbench with accessible management actions", () => {
    const html = renderToStaticMarkup(<MemoryManagerView onClose={() => undefined} onError={() => undefined} />);

    expect(html).toContain("aria-label=\"长期记忆管理\"");
    expect(html).toContain("长期记忆");
    expect(html).toContain("新建记忆");
    expect(html).toContain("搜索记忆");
    expect(html).toContain("正在读取记忆");
    expect(html).toContain('<div class="memory-header-actions"><div class="memory-ledger-status"');
    expect(html).toContain("条记忆");
    expect(html).toContain("清理 cold");
  });

  it("renders semantic enamel heat and recall badges", () => {
    const hot = renderToStaticMarkup(<MemoryHeatBadge heat="hot" recallTotal={12} />);
    const cold = renderToStaticMarkup(<MemoryHeatBadge heat="cold" recallTotal={0} />);
    expect(hot).toContain('data-heat="hot"'); expect(hot).toContain("↻ 12");
    expect(cold).toContain('data-heat="cold"');
  });
});
