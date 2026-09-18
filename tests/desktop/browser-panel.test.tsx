import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { BrowserPanel } from "../../src/desktop/renderer/browser-panel.js";

const panelProps = {
  setOpen: vi.fn(),
  onClose: vi.fn(),
  fullscreen: false,
  setFullscreen: vi.fn(),
  onWidth: vi.fn(),
};

describe("embedded browser panel", () => {
  it("renders toolbar, tab bar and the waiting page when open", () => {
    const output = renderToStaticMarkup(<BrowserPanel open {...panelProps} />);
    expect(output).toContain('class="browser-panel"');
    expect(output).toContain("内嵌浏览器");
    expect(output).toContain('placeholder="输入网址，打开新标签页"');
    expect(output).toContain('aria-label="浏览器标签页"');
    expect(output).toContain('class="browser-viewport"');
    expect(output).toContain("当前项目还没有运行中的任务");
    expect(output).toContain("关闭浏览器并中断当前任务");
  });

  it("offers a width splitter and a fullscreen toggle", () => {
    const output = renderToStaticMarkup(<BrowserPanel open {...panelProps} />);
    expect(output).toContain('class="browser-splitter"');
    expect(output).toContain("拖拽调整浏览器面板宽度");
    expect(output).toContain("⛶ 全屏");
    expect(output).toContain('data-fullscreen="false"');
  });

  it("shows the exit-fullscreen affordance when expanded", () => {
    const output = renderToStaticMarkup(
      <BrowserPanel open {...panelProps} fullscreen />,
    );
    expect(output).toContain("退出全屏");
    expect(output).toContain('data-fullscreen="true"');
  });

  it("renders nothing when closed so the native view stays hidden", () => {
    const output = renderToStaticMarkup(<BrowserPanel open={false} {...panelProps} />);
    expect(output).toBe("");
  });
});
