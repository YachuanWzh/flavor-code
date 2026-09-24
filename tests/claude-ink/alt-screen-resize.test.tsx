import { PassThrough } from "node:stream";
import React, { createRef, useContext } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { AlternateScreen } from "../../src/claude-ink/components/AlternateScreen.js";
import { TerminalSizeContext } from "../../src/claude-ink/components/TerminalSizeContext.js";
import type { ScrollBoxHandle } from "../../src/claude-ink/components/ScrollBox.js";
import type { Frame } from "../../src/claude-ink/frame.js";
import Ink from "../../src/claude-ink/ink.js";
import { LogUpdate } from "../../src/claude-ink/log-update.js";
import { cellAt, CellWidth, CharPool, createScreen, HyperlinkPool, setCellAt, StylePool } from "../../src/claude-ink/screen.js";
import { TerminalLayout } from "../../src/ui/app.js";

type MutableWriteStream = NodeJS.WriteStream & { columns: number; rows: number; isTTY: boolean };
type InspectableInk = {
  frontFrame: Frame;
  handleResize: () => void;
  onRender: () => void;
};
const mounted: Ink[] = [];

afterEach(() => {
  while (mounted.length > 0) mounted.pop()?.unmount();
});

function screenText(frame: Frame): string {
  const rows: string[] = [];
  for (let y = 0; y < frame.screen.height; y++) {
    let row = "";
    for (let x = 0; x < frame.screen.width; x++) {
      const cell = cellAt(frame.screen, x, y);
      if (cell && cell.width !== CellWidth.SpacerTail) row += cell.char;
    }
    rows.push(row.trimEnd());
  }
  return rows.join("\n");
}

function Home({ scrollRef }: { scrollRef: React.RefObject<ScrollBoxHandle | null> }) {
  const size = useContext(TerminalSizeContext);
  return <TerminalLayout
    model="test-model"
    workspaceName="workspace"
    completed={[]}
    input=""
    promptCursor={0}
    columns={size?.columns ?? 80}
    rows={size?.rows ?? 24}
    activeSession={false}
    scrollRef={scrollRef}
  />;
}

describe("alternate-screen resize", () => {
  it("keeps the home screen fixed and restores it after a hidden-panel resize", () => {
    const stdout = new PassThrough() as unknown as MutableWriteStream;
    stdout.columns = 90;
    stdout.rows = 18;
    stdout.isTTY = false;
    const stdin = new PassThrough() as unknown as NodeJS.ReadStream;
    const ink = new Ink({ stdout, stdin, stderr: stdout, exitOnCtrlC: false, patchConsole: false });
    mounted.push(ink);
    const inspect = ink as unknown as InspectableInk;
    const scrollRef = createRef<ScrollBoxHandle>();
    ink.render(<AlternateScreen mouseTracking={false}><Home scrollRef={scrollRef} /></AlternateScreen>);
    ink.setAltScreenActive(true, false);
    inspect.onRender();
    expect(screenText(inspect.frontFrame)).toContain("Welcome back!");
    expect(scrollRef.current).toBeNull();

    stdout.isTTY = true;
    stdout.rows = 0;
    inspect.handleResize();
    inspect.onRender();
    expect(inspect.frontFrame.screen.height).toBe(18);

    for (const rows of [5, 24, 8, 18]) {
      stdout.rows = rows;
      inspect.handleResize();
      inspect.onRender();
      expect(inspect.frontFrame.screen.height).toBe(rows);
      expect(scrollRef.current).toBeNull();
    }
    expect(screenText(inspect.frontFrame)).toContain("Welcome back!");
    stdout.isTTY = false;
  });

  it("keeps approval actions on screen while long details scroll in a short window", () => {
    const stdout = new PassThrough() as unknown as MutableWriteStream;
    stdout.columns = 44;
    stdout.rows = 12;
    stdout.isTTY = false;
    const stdin = new PassThrough() as unknown as NodeJS.ReadStream;
    const ink = new Ink({ stdout, stdin, stderr: stdout, exitOnCtrlC: false, patchConsole: false });
    mounted.push(ink);
    const inspect = ink as unknown as InspectableInk;
    const focusScrollRef = createRef<ScrollBoxHandle>();
    ink.render(<AlternateScreen mouseTracking={false}><TerminalLayout
      model="test-model" workspaceName="workspace" completed={[]}
      input="" promptCursor={0} columns={44} rows={12} activeSession
      approval={{
        id: "short", agent: "main", tool: "Shell", reason: "Review the command",
        command: "node", args: ["script.js"], cwd: "/work",
        paths: Array.from({ length: 12 }, (_, index) => `/work/file-${index}.txt`),
      }} approvalExpanded focusScrollRef={focusScrollRef}
    /></AlternateScreen>);
    ink.setAltScreenActive(true, false);
    inspect.onRender();

    expect(focusScrollRef.current).not.toBeNull();
    stdout.isTTY = true;
    stdout.rows = 6;
    inspect.handleResize();
    ink.render(<AlternateScreen mouseTracking={false}><TerminalLayout
      model="test-model" workspaceName="workspace" completed={[]}
      input="" promptCursor={0} columns={44} rows={6} activeSession
      approval={{
        id: "short", agent: "main", tool: "Shell", reason: "Review the command",
        command: "node", args: ["script.js"], cwd: "/work",
        paths: Array.from({ length: 12 }, (_, index) => `/work/file-${index}.txt`),
      }} approvalExpanded focusScrollRef={focusScrollRef}
    /></AlternateScreen>);
    inspect.onRender();
    expect(screenText(inspect.frontFrame)).toContain("y=once · n=deny");
    expect(screenText(inspect.frontFrame)).toContain("v=details · e=accept edits");

    focusScrollRef.current?.scrollToBottom();
    inspect.onRender();
    expect(screenText(inspect.frontFrame)).toContain("Path 12: /work/file-11.txt");
    expect(screenText(inspect.frontFrame)).toContain("y=once · n=deny");
    stdout.isTTY = false;
  });

  it("does not emit a newline after the last alternate-screen row on a full reset", () => {
    const styles = new StylePool();
    const chars = new CharPool();
    const links = new HyperlinkPool();
    const makeFrame = (rows: number, viewportRows: number): Frame => ({
      screen: createScreen(12, rows, styles, chars, links),
      viewport: { width: 12, height: viewportRows + 1 },
      cursor: { x: 0, y: Math.max(0, rows - 1), visible: false },
    });
    const prev = makeFrame(8, 8);
    const next = makeFrame(4, 4);
    setCellAt(next.screen, 0, 3, { char: "X", styleId: styles.none, width: CellWidth.Narrow, hyperlink: undefined });
    const diff = new LogUpdate({ isTTY: true, stylePool: styles }).render(prev, next, true);
    expect(diff[0]?.type).toBe("clearTerminal");
    expect(diff.filter(p => p.type === "stdout").map(p => p.content).join(""))
      .not.toContain("\n");
    expect(diff.reduce((sum, p) => sum + (p.type === "cursorMove" ? p.y : 0), 0)).toBe(3);

    const growing = new LogUpdate({ isTTY: true, stylePool: styles })
      .render(makeFrame(0, 4), next, true);
    expect(growing.filter(p => p.type === "stdout").map(p => p.content).join(""))
      .not.toContain("\n");
  });
});
