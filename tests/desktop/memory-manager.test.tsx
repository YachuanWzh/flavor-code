import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { MemoryManagerView } from "../../src/desktop/renderer/memory-manager.js";

describe("MemoryManagerView", () => {
  it("renders a focused project-memory workbench with accessible management actions", () => {
    const html = renderToStaticMarkup(<MemoryManagerView onClose={() => undefined} onError={() => undefined} />);

    expect(html).toContain("aria-label=\"长期记忆管理\"");
    expect(html).toContain("长期记忆");
    expect(html).toContain("新建记忆");
    expect(html).toContain("搜索记忆");
    expect(html).toContain("正在读取记忆");
  });
});
