import { PassThrough } from "node:stream";
import React, { createRef } from "react";
import { afterEach, describe, expect, it } from "vitest";

import type { ScrollBoxHandle } from "../../src/claude-ink/index.js";
import Ink from "../../src/claude-ink/ink.js";
import type { Frame } from "../../src/claude-ink/frame.js";
import { cellAt, CellWidth, type Screen } from "../../src/claude-ink/screen.js";
import { TerminalLayout, scrollDown, scrollUp } from "../../src/ui/app.js";
import type { TranscriptTurn } from "../../src/ui/transcript.js";

type MutableWriteStream = NodeJS.WriteStream & {
  columns: number;
  rows: number;
  isTTY: boolean;
};

type InspectableInk = {
  render: Ink["render"];
  unmount: Ink["unmount"];
  frontFrame: Frame;
  onRender: () => void;
};

const mounted: Ink[] = [];

afterEach(() => {
  while (mounted.length > 0) mounted.pop()?.unmount();
});

function createInk(columns: number, rows: number): InspectableInk {
  const stdout = new PassThrough() as unknown as MutableWriteStream;
  stdout.columns = columns;
  stdout.rows = rows;
  stdout.isTTY = false;
  const stdin = new PassThrough() as unknown as NodeJS.ReadStream;
  const ink = new Ink({ stdout, stdin, stderr: stdout, exitOnCtrlC: false, patchConsole: false });
  mounted.push(ink);
  return ink as unknown as InspectableInk;
}

function screenLines(screen: Screen): string[] {
  const lines: string[] = [];
  for (let y = 0; y < screen.height; y += 1) {
    let line = "";
    for (let x = 0; x < screen.width; x += 1) {
      const cell = cellAt(screen, x, y);
      if (cell === undefined || cell.width === CellWidth.SpacerTail) continue;
      line += cell.char;
    }
    lines.push(line.trimEnd());
  }
  return lines;
}

function makeTurns(count: number, linesPerTurn: number): TranscriptTurn[] {
  return Array.from({ length: count }, (_, t) => {
    const text = Array.from({ length: linesPerTurn }, (_, i) => `T${t}-L${i}`).join("\n");
    return {
      id: t + 1,
      prompt: `prompt-${t}`,
      assistantText: text,
      statusLines: [],
      blocks: [{ kind: "text" as const, text }],
    };
  });
}

const COLUMNS = 80;
const ROWS = 16;

function renderLayout(ink: InspectableInk, scrollRef: React.RefObject<ScrollBoxHandle | null>,
  completed: TranscriptTurn[], activeText?: string): void {
  ink.render(
    <TerminalLayout
      model="model"
      workspaceName="workspace"
      completed={completed}
      {...(activeText === undefined
        ? {}
        : {
            active: {
              id: 999,
              prompt: "stream",
              assistantText: activeText,
              statusLines: [],
              blocks: [{ kind: "text" as const, text: activeText }],
            },
          })}
      input=""
      promptCursor={0}
      columns={COLUMNS}
      rows={ROWS}
      activeSession={activeText !== undefined}
      scrollRef={scrollRef}
    />,
  );
  ink.onRender();
}

describe("wheel scroll reaches the transcript bottom", () => {
  it("scrolls all the way back to the bottom after scrolling up through a long static transcript", () => {
    const ink = createInk(COLUMNS, ROWS);
    const scrollRef = createRef<ScrollBoxHandle>();
    const completed = makeTurns(6, 12);
    renderLayout(ink, scrollRef, completed);

    // Sticky default: the newest line is on screen.
    expect(screenLines(ink.frontFrame.screen).join("\n")).toContain("T5-L11");

    // Wheel far up (clamps at the top). The collapsed budget hides the two
    // oldest turns, so the mounted top of the scroll area is T2-L0.
    for (let tick = 0; tick < 60; tick += 1) {
      if (scrollRef.current === null) throw new Error("missing scroll handle");
      scrollUp(scrollRef.current, 3);
      ink.onRender();
    }
    let visible = screenLines(ink.frontFrame.screen).join("\n");
    expect(visible).toContain("T2-L0");
    expect(visible).not.toContain("T5-L11");

    // Wheel back down: the tail must become visible again.
    for (let tick = 0; tick < 120; tick += 1) {
      if (scrollRef.current === null) throw new Error("missing scroll handle");
      scrollDown(scrollRef.current, 3);
      ink.onRender();
      visible = screenLines(ink.frontFrame.screen).join("\n");
      if (visible.includes("T5-L11")) break;
    }
    expect(screenLines(ink.frontFrame.screen).join("\n")).toContain("T5-L11");
    const handle = scrollRef.current;
    if (handle === null) throw new Error("missing scroll handle");
    expect(handle.getScrollTop() + handle.getPendingDelta())
      .toBeGreaterThanOrEqual(Math.max(0, handle.getScrollHeight() - handle.getViewportHeight()) - 3);
  });

  it("reaches the bottom of a transcript whose content wraps wide CJK text", () => {
    const ink = createInk(COLUMNS, ROWS);
    const scrollRef = createRef<ScrollBoxHandle>();
    const wide = Array.from({ length: 40 }, (_, i) => `宽字符换行内容-${"中文字符".repeat(30)}-row${i}`);
    const turn: TranscriptTurn = {
      id: 1,
      prompt: "wide",
      assistantText: wide.join("\n"),
      statusLines: [],
      blocks: [{ kind: "text", text: wide.join("\n") }],
    };
    renderLayout(ink, scrollRef, [turn]);
    expect(screenLines(ink.frontFrame.screen).join("\n")).toContain("row39");

    for (let tick = 0; tick < 400; tick += 1) {
      if (scrollRef.current === null) throw new Error("missing scroll handle");
      scrollUp(scrollRef.current, 3);
      ink.onRender();
    }
    expect(screenLines(ink.frontFrame.screen).join("\n")).toContain("row0");
    for (let tick = 0; tick < 400; tick += 1) {
      if (scrollRef.current === null) throw new Error("missing scroll handle");
      scrollDown(scrollRef.current, 3);
      ink.onRender();
      if (screenLines(ink.frontFrame.screen).join("\n").includes("row39")) break;
    }
    expect(screenLines(ink.frontFrame.screen).join("\n")).toContain("row39");
  });

  it("reaches the live bottom while new output keeps streaming", () => {
    const ink = createInk(COLUMNS, ROWS);
    const scrollRef = createRef<ScrollBoxHandle>();
    const completed = makeTurns(4, 10);
    renderLayout(ink, scrollRef, completed);

    // User scrolls up to read while streaming continues below.
    for (let tick = 0; tick < 10; tick += 1) {
      if (scrollRef.current === null) throw new Error("missing scroll handle");
      scrollUp(scrollRef.current, 3);
      ink.onRender();
    }
    for (let tick = 0; tick < 10; tick += 1) {
      const lines = Array.from({ length: 3 + tick }, (_, i) => `S-${i}`);
      renderLayout(ink, scrollRef, completed, lines.join("\n"));
    }
    expect(screenLines(ink.frontFrame.screen).join("\n")).not.toContain("S-12");

    // Wheel down during streaming: within a bounded number of ticks the newest
    // streamed line must appear (the "stream outruns the wheel" failure mode).
    for (let tick = 0; tick < 80; tick += 1) {
      if (scrollRef.current === null) throw new Error("missing scroll handle");
      scrollDown(scrollRef.current, 3);
      const lines = Array.from({ length: 13 + Math.min(tick, 8) }, (_, i) => `S-${i}`);
      renderLayout(ink, scrollRef, completed, lines.join("\n"));
      const newest = `S-${12 + Math.min(tick, 8)}`;
      if (screenLines(ink.frontFrame.screen).join("\n").includes(newest)) return;
    }
    throw new Error("wheel-down during streaming never surfaced the newest line");
  });

  it("reaches the bottom after a burst of wheel events coalesces into one frame", () => {
    const ink = createInk(COLUMNS, ROWS);
    const scrollRef = createRef<ScrollBoxHandle>();
    const completed = makeTurns(6, 12);
    renderLayout(ink, scrollRef, completed);
    for (let tick = 0; tick < 20; tick += 1) {
      if (scrollRef.current === null) throw new Error("missing scroll handle");
      scrollUp(scrollRef.current, 3);
      ink.onRender();
    }
    // 15 wheel-down events land in one input batch (no renders in between),
    // then the user keeps flicking in bursts until the bottom shows.
    const handle = scrollRef.current;
    if (handle === null) throw new Error("missing scroll handle");
    for (let burst = 0; burst < 8; burst += 1) {
      for (let tick = 0; tick < 15; tick += 1) scrollDown(handle, 3);
      for (let tick = 0; tick < 10; tick += 1) ink.onRender();
      if (screenLines(ink.frontFrame.screen).join("\n").includes("T5-L11")) break;
    }
    expect(screenLines(ink.frontFrame.screen).join("\n")).toContain("T5-L11");
  });

  it("reaches the bottom under up/down wheel tremor (interleaved scroll events)", () => {
    const ink = createInk(COLUMNS, ROWS);
    const scrollRef = createRef<ScrollBoxHandle>();
    const completed = makeTurns(6, 12);
    renderLayout(ink, scrollRef, completed);
    const handle = scrollRef.current;
    if (handle === null) throw new Error("missing scroll handle");
    for (let tick = 0; tick < 20; tick += 1) {
      scrollUp(handle, 3);
      ink.onRender();
    }
    // Trackpad-style jitter: every second down-click emits a stray up-click.
    for (let tick = 0; tick < 200; tick += 1) {
      scrollDown(handle, 3);
      ink.onRender();
      if (tick % 2 === 1) {
        scrollUp(handle, 3);
        ink.onRender();
      }
      if (screenLines(ink.frontFrame.screen).join("\n").includes("T5-L11")) break;
    }
    expect(screenLines(ink.frontFrame.screen).join("\n")).toContain("T5-L11");
  });
});
