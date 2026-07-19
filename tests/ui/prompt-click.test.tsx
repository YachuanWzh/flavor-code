import React from "react";
import { describe, expect, it } from "vitest";

import { ClickEvent } from "../../src/claude-ink/events/click-event.js";
import { PromptLine, promptCursorFromClick } from "../../src/ui/app.js";

describe("promptCursorFromClick", () => {
  it("maps prompt gutter, text cells, and trailing blank space", () => {
    const at = (localColumn: number): number => promptCursorFromClick(
      "hello",
      [],
      { columns: 12, lineIndex: 0, localColumn },
    );

    expect(at(0)).toBe(0);
    expect(at(4)).toBe(2);
    expect(at(99)).toBe(5);
  });

  it("maps an absolute wrapped row back to its source offset", () => {
    expect(promptCursorFromClick(
      "abcdef",
      [],
      { columns: 5, lineIndex: 1, localColumn: 3 },
    )).toBe(4);
  });

  it("uses terminal cell widths for wide characters", () => {
    const beforeWide = promptCursorFromClick(
      "a界b",
      [],
      { columns: 12, lineIndex: 0, localColumn: 3 },
    );
    const afterWide = promptCursorFromClick(
      "a界b",
      [],
      { columns: 12, lineIndex: 0, localColumn: 4 },
    );

    expect(beforeWide).toBe(1);
    expect(afterWide).toBe(2);
    expect(promptCursorFromClick(
      "a🍜b",
      [],
      { columns: 12, lineIndex: 0, localColumn: 4 },
    )).toBe(2);
  });

  it("maps every cell in a collapsed paste label to the source paste end", () => {
    const pasted = "first line\nsecond line";
    const prefix = "pre ";
    const input = `${prefix}${pasted} tail`;
    const sourceEnd = [...`${prefix}${pasted}`].length;

    expect(promptCursorFromClick(
      input,
      [{ id: 1, text: pasted }],
      { columns: 80, lineIndex: 0, localColumn: 2 + [...prefix].length },
    )).toBe(sourceEnd);
    expect(promptCursorFromClick(
      input,
      [{ id: 1, text: pasted }],
      { columns: 80, lineIndex: 0, localColumn: 2 + [...prefix].length + 8 },
    )).toBe(sourceEnd);
  });
});

it("moves the cursor from a click on the visible prompt row", () => {
  const moved: number[] = [];
  const prompt = PromptLine({
    input: "abcdef",
    pastedBlocks: [],
    cursor: 6,
    columns: 7,
    maxVisibleLines: 1,
    onCursorChange: (cursor) => moved.push(cursor),
  });
  const row = React.Children.toArray(prompt.props.children)[0] as React.ReactElement<{
    onClick?: (event: ClickEvent) => void;
  }>;
  const event = new ClickEvent(0, 0, false);
  event.localCol = 3;

  row.props.onClick?.(event);

  expect(moved).toEqual([4]);
});
