import { PassThrough } from "node:stream";
import React, { createRef } from "react";
import { afterEach, describe, expect, it } from "vitest";

import ScrollBox, { type ScrollBoxHandle } from "../../src/claude-ink/components/ScrollBox.js";
import { AlternateScreen } from "../../src/claude-ink/components/AlternateScreen.js";
import type { Frame } from "../../src/claude-ink/frame.js";
import Ink from "../../src/claude-ink/ink.js";
import { cellAt, CellWidth, type Screen } from "../../src/claude-ink/screen.js";
import { AssistantText } from "../../src/ui/assistant-text.js";

type MutableWriteStream = NodeJS.WriteStream & {
  columns: number;
  rows: number;
  isTTY: boolean;
};

type InspectableInk = {
  render: Ink["render"];
  unmount: Ink["unmount"];
  setAltScreenActive: Ink["setAltScreenActive"];
  frontFrame: Frame;
  handleResize: () => void;
  onRender: () => void;
  terminalColumns: number;
};

const mounted: Ink[] = [];

afterEach(() => {
  while (mounted.length > 0) mounted.pop()?.unmount();
});

function createStream(columns: number, rows: number): MutableWriteStream {
  const stream = new PassThrough() as unknown as MutableWriteStream;
  stream.columns = columns;
  stream.rows = rows;
  stream.isTTY = false;
  return stream;
}

function createInk(columns: number, rows: number): {
  ink: InspectableInk;
  stdout: MutableWriteStream;
} {
  const stdout = createStream(columns, rows);
  const stdin = new PassThrough() as unknown as NodeJS.ReadStream;
  const stderr = createStream(columns, rows);
  const ink = new Ink({
    stdout,
    stdin,
    stderr,
    exitOnCtrlC: false,
    patchConsole: false,
  });
  mounted.push(ink);
  return { ink: ink as unknown as InspectableInk, stdout };
}

function screenLines(screen: Screen): string[] {
  const lines: string[] = [];
  for (let y = 0; y < screen.height; y++) {
    let line = "";
    for (let x = 0; x < screen.width; x++) {
      const cell = cellAt(screen, x, y);
      if (cell === undefined || cell.width === CellWidth.SpacerTail) continue;
      line += cell.char;
    }
    lines.push(line.trimEnd());
  }
  return lines;
}

function nestedCodeMarkdown(): string {
  const fence = "`".repeat(3);
  return [
    "- refs:",
    `  ${fence}text`,
    "  path-ok",
    `  ${fence}`,
    "- stale:",
    `  ${fence}json`,
    "  {ok:true}",
    `  ${fence}`,
  ].join("\n");
}

function expectCompleteCodeBlocks(frame: Frame): void {
  const lines = screenLines(frame.screen);
  const textBorder = lines.find((line) => line.includes(" text "));
  const jsonBorder = lines.find((line) => line.includes(" json "));
  expect(textBorder?.trimStart()).toMatch(/^╭.* text .*╮$/u);
  expect(jsonBorder?.trimStart()).toMatch(/^╭.* json .*╮$/u);
  expect(lines.some((line) => line.includes("path-ok"))).toBe(true);
  expect(lines.some((line) => line.includes("{ok:true}"))).toBe(true);
}

describe("native CLI markdown renderer", () => {
  it("keeps memoized list code blocks complete across repeated terminal resizes", () => {
    const { ink, stdout } = createInk(100, 30);
    ink.render(
      <AlternateScreen mouseTracking={false}>
        <AssistantText text={nestedCodeMarkdown()} />
      </AlternateScreen>,
    );
    ink.setAltScreenActive(true, false);
    ink.onRender();
    expectCompleteCodeBlocks(ink.frontFrame);

    for (const columns of [48, 120, 32, 80, 24, 96]) {
      stdout.columns = columns;
      stdout.isTTY = true;
      ink.handleResize();
      stdout.isTTY = false;
      expect(ink.terminalColumns).toBe(columns);
      expect(ink.frontFrame.screen.width).toBe(columns);
      expectCompleteCodeBlocks(ink.frontFrame);
    }
  });

  it("does not lose single-line code bodies while ScrollBox reuses and shifts frames", () => {
    const { ink } = createInk(64, 12);
    const scrollRef = createRef<ScrollBoxHandle>();
    const fence = "`".repeat(3);
    const markdown = Array.from({ length: 8 }, (_, index) => [
      `- item-${index}`,
      `  ${fence}text`,
      `  value-${index}`,
      `  ${fence}`,
    ].join("\n")).join("\n");

    ink.render(
      <ScrollBox ref={scrollRef} height={8} width="100%" flexDirection="column">
        <AssistantText text={markdown} />
      </ScrollBox>,
    );

    expect(screenLines(ink.frontFrame.screen).join("\n")).toContain("value-0");
    for (const index of [1, 2, 4, 6, 3, 0, 7]) {
      scrollRef.current?.scrollTo(index * 4);
      ink.onRender();
      const visible = screenLines(ink.frontFrame.screen).join("\n");
      expect(visible).toContain(`value-${index}`);
    }
  });
});
