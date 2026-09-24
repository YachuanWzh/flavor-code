import { expect, it } from "vitest";
import { INITIAL_STATE, parseMultipleKeypresses, type ParsedKey } from "../../src/claude-ink/parse-keypress.js";
import { InputEvent } from "../../src/claude-ink/events/input-event.js";
import { supportsExtendedKeys } from "../../src/claude-ink/terminal.js";
import { promptHistoryAction } from "../../src/ui/app.js";

it("enables extended key reporting for normalized macOS terminal names", () => {
  expect(supportsExtendedKeys("iTerm.app")).toBe(true);
  expect(supportsExtendedKeys("iterm.app")).toBe(true);
  expect(supportsExtendedKeys("WezTerm")).toBe(true);
  expect(supportsExtendedKeys("wezterm")).toBe(true);
});

it("maps macOS Command+Z CSI-u input to undo and redo", () => {
  const parseEvent = (sequence: string): InputEvent => {
    const [items] = parseMultipleKeypresses({ ...INITIAL_STATE }, sequence);
    expect(items).toHaveLength(1);
    return new InputEvent(items[0] as ParsedKey);
  };

  const undo = parseEvent("\x1b[122;9u");
  expect(promptHistoryAction(undo.input, undo.key, "darwin")).toBe("undo");

  const redo = parseEvent("\x1b[122;10u");
  expect(promptHistoryAction(redo.input, redo.key, "darwin")).toBe("redo");
});
