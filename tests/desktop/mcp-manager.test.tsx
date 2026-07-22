import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { McpManagerView } from "../../src/desktop/renderer/mcp-manager.js";

describe("McpManagerView", () => {
  it("renders an accessible two-pane project service workbench", () => {
    const html = renderToStaticMarkup(<McpManagerView onClose={() => undefined} onError={() => undefined} />);

    expect(html).toContain("aria-label=\"MCP 服务管理\"");
    expect(html).toContain("MCP 服务");
    expect(html).toContain("添加服务");
    expect(html).toContain("搜索服务");
    expect(html).toContain("正在读取项目配置");
    expect(html).toContain(".flavor/flavor.json");
  });
});
