import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  AgentWorkbench,
  PalsPane,
  buildAstGraphModel,
  parseReviewDiff,
  projectAstGraphPoint,
  renderTerminalBuffer,
  reconcileTerminalSelection,
  sessionTreeRows,
  terminalShellName,
  terminalGridSize,
  zoomAstGraphViewport,
} from "../../src/desktop/renderer/agent-workbench.js";

describe("AgentWorkbench", () => {
  it("renders every P0/P1 desktop surface from one accessible workbench", () => {
    const html = renderToStaticMarkup(<AgentWorkbench snapshot={{
      workspace: "C:\\project", sessions: [], diagnostics: [], models: [], jobs: [],
      activeSession: { sessionId: "session-one", mainModel: "openai:gpt-5", subagentModel: "openai:gpt-5-mini", permissionMode: "default", busy: false, queue: { steering: [], followUp: [] }, environment: "worktree", workingDirectory: "C:\\worktree" },
    }} onClose={() => undefined} onError={() => undefined} onCompose={() => undefined} />);

    expect(html).toContain("Agent 工作台");
    for (const label of ["执行", "时间机", "终端", "审查", "预览", "上下文", "代码图", "Pals", "工作树"]) expect(html).toContain(`>${label}<`);
    expect(html).toContain("隔离工作树");
    expect(html).toContain("EXECUTION TRACE");
  });

  it("groups Pal messaging and co-work into balanced action cards", () => {
    const html = renderToStaticMarkup(<PalsPane onError={() => undefined} />);

    expect(html).toContain("pals-compose-grid");
    expect(html).toContain("发消息或委托任务");
    expect(html).toContain("共同完成一个目标");
    expect(html).toContain("直接沟通");
    expect(html).toContain("异步执行");
    expect(html).toContain("没有选中 Pal");
  });

  it("parses review files and hunks for navigation", () => {
    const files = parseReviewDiff([
      "diff --git a/src/a.ts b/src/a.ts", "--- a/src/a.ts", "+++ b/src/a.ts",
      "@@ -1 +1 @@", "-old", "+new", "@@ -8,0 +9 @@", "+next",
      "diff --git a/src/b.ts b/src/b.ts", "--- a/src/b.ts", "+++ b/src/b.ts", "@@ -2 +2 @@", "+b",
    ].join("\n"));
    expect(files.map((file) => file.path)).toEqual(["src/a.ts", "src/b.ts"]);
    expect(files[0]?.hunks).toHaveLength(2);
    expect(files[0]?.additions).toBe(2);
    expect(files[0]?.deletions).toBe(1);
  });

  it("builds a bounded, clickable code graph around the selected symbol", () => {
    const origin = { id: "target", kind: "function", name: "target", qualifiedName: "target", filePath: "src/a.ts", language: "typescript", startLine: 8, endLine: 10 };
    const caller = { ...origin, id: "caller", name: "caller", qualifiedName: "caller", startLine: 1 };
    const callee = { ...origin, id: "callee", name: "callee", qualifiedName: "callee", startLine: 20 };
    const graph = buildAstGraphModel(origin, { origin, callers: [caller], callees: [callee], impact: [{ ...caller, hop: 1 }] });
    expect(graph.nodes.map((node) => node.id)).toEqual(expect.arrayContaining(["target", "caller", "callee"]));
    expect(graph.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ from: "caller", to: "target", kind: "caller" }),
      expect.objectContaining({ from: "target", to: "callee", kind: "callee" }),
    ]));
  });

  it("zooms the code graph around the pointer and clamps extreme scales", () => {
    expect(zoomAstGraphViewport({ x: 0, y: 0, scale: 1 }, { x: 200, y: 100 }, 2)).toEqual({
      x: -200, y: -100, scale: 2,
    });
    expect(zoomAstGraphViewport({ x: 12, y: 18, scale: 1 }, { x: 0, y: 0 }, 99).scale).toBe(2.4);
    expect(zoomAstGraphViewport({ x: 12, y: 18, scale: 1 }, { x: 0, y: 0 }, 0.01).scale).toBe(0.55);
  });

  it("projects graph nodes onto crisp integer pixels without scaling their DOM", () => {
    expect(projectAstGraphPoint({ x: 50, y: 25 }, { x: -20.4, y: 10.2, scale: 2 }, { width: 400, height: 300 })).toEqual({
      x: 380, y: 160,
    });
  });

  it("lays dense impact nodes into readable rows of at most three", () => {
    const origin = { id: "target", kind: "function", name: "target", qualifiedName: "target", filePath: "src/a.ts", language: "typescript", startLine: 8, endLine: 10 };
    const impact = Array.from({ length: 12 }, (_, index) => ({ ...origin, id: `impact-${index}`, name: `impact-${index}`, hop: 2 }));
    const graph = buildAstGraphModel(origin, { origin, callers: [], callees: [], impact });
    const impactNodes = graph.nodes.filter((node) => node.role === "impact");
    const rows = new Map<number, typeof impactNodes>();
    for (const node of impactNodes) rows.set(node.y, [...(rows.get(node.y) ?? []), node]);
    expect([...rows.values()].map((row) => row.length)).toEqual([3, 3, 3, 3]);
    for (const row of rows.values()) {
      const positions = row.map((node) => node.x).sort((a, b) => a - b);
      expect(positions[1]! - positions[0]!).toBeGreaterThanOrEqual(25);
    }
  });

  it("derives tree depth and terminal dimensions within IPC limits", () => {
    const rows = sessionTreeRows([
      { id: "root", parentId: null, createdAt: "2026-08-25T00:00:00Z", prompt: "root", checkpointId: "checkpoint-a", context: { messages: [] } },
      { id: "child", parentId: "root", createdAt: "2026-08-25T00:01:00Z", prompt: "child", checkpointId: "checkpoint-b", context: { messages: [] } },
    ]);
    expect(rows.map((row) => row.depth)).toEqual([0, 1]);
    expect(terminalGridSize(10_000, 10_000)).toEqual({ columns: 500, rows: 300 });
    expect(terminalGridSize(80, 40)).toEqual({ columns: 20, rows: 5 });
  });

  it("renders Windows PTY output without leaking terminal control sequences", () => {
    const output = [
      "\u001b[?9001h\u001b[2J\u001b[25;1H",
      "Microsoft Windows [版本 10.0.26200.9168]\r\n",
      "(c) Microsoft Corporation. 保留所有权利。\r\n",
      "\u001b[4;1HC:\\work>\u001b[?25h",
    ].join("");

    const rendered = renderTerminalBuffer(output, 100, 30);
    expect(rendered).not.toContain("\u001b");
    expect(rendered).not.toContain("[?9001h");
    expect(rendered).toContain("Microsoft Windows");
    expect(rendered).toContain("C:\\work>");
    expect(rendered.split("\n").filter((line) => line.trim() === "")).toHaveLength(0);
  });

  it("applies carriage-return rewrites and presents compact shell names", () => {
    expect(renderTerminalBuffer("progress 10%\rprogress 20%", 80, 10)).toBe("progress 20%");
    expect(terminalShellName("C:\\WINDOWS\\system32\\cmd.exe")).toBe("cmd.exe");
    expect(terminalShellName("/bin/zsh")).toBe("zsh");
  });

  it("moves selection away from a terminal that was closed", () => {
    const terminals = [
      { id: "term-closed", state: "closed" as const },
      { id: "term-next", state: "running" as const },
      { id: "term-exited", state: "exited" as const },
    ];
    expect(reconcileTerminalSelection("term-closed", terminals)).toBe("term-next");
    expect(reconcileTerminalSelection("term-missing", terminals)).toBe("term-next");
    expect(reconcileTerminalSelection("term-exited", terminals)).toBe("term-exited");
    expect(reconcileTerminalSelection("term-closed", [])).toBeUndefined();
  });
});
