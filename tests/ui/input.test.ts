import { expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { completionKeyAction, editPrompt, navigateHistory, slashKeyAction } from "../../src/ui/app.js";
import type { SlashCompletion } from "../../src/ui/slash-completion.js";
import { installSigintHandler } from "../../src/ui/signals.js";

it("edits prompts by Unicode code point with a movable cursor", () => {
  let state = { text: "A🍜B", cursor: 3 };
  state = editPrompt(state, { type: "left" });
  state = editPrompt(state, { type: "backspace" });
  expect(state).toEqual({ text: "AB", cursor: 1 });
  state = editPrompt(state, { type: "insert", value: "香" });
  expect(state).toEqual({ text: "A香B", cursor: 2 });
});

it("installs and cleans the process SIGINT bridge", () => {
  const source = new EventEmitter(); let calls = 0;
  const cleanup = installSigintHandler(source, () => { calls += 1; });
  source.emit("SIGINT"); cleanup(); source.emit("SIGINT");
  expect(calls).toBe(1);
});

it("uses only up and down navigation to recall submitted queries", () => {
  const history = ["one", "two"];
  const recalled = navigateHistory({ history, cursor: 2 }, "up");
  expect(recalled).toEqual({ cursor: 1, input: "two", promptCursor: 3 });

  const older = navigateHistory({ history, cursor: recalled.cursor }, "up");
  expect(older).toEqual({ cursor: 0, input: "one", promptCursor: 3 });

  const cleared = navigateHistory({ history, cursor: older.cursor }, "down");
  expect(cleared).toEqual({ cursor: 1, input: "two", promptCursor: 3 });
});

it("routes selection keys to an open slash menu only", () => {
  const completion: SlashCompletion = {
    query: "",
    items: [{ name: "help", kind: "command" }],
    selectedIndex: 0,
    windowStart: 0,
  };
  expect(slashKeyAction({ upArrow: true, downArrow: false, tab: false, escape: false }, completion))
    .toEqual({ type: "select", delta: -1 });
  expect(slashKeyAction({ upArrow: false, downArrow: true, tab: false, escape: false }, completion))
    .toEqual({ type: "select", delta: 1 });
  expect(slashKeyAction({ upArrow: false, downArrow: false, tab: true, escape: false }, completion))
    .toEqual({ type: "complete" });
  expect(slashKeyAction({ upArrow: false, downArrow: false, tab: false, escape: true }, completion))
    .toEqual({ type: "dismiss" });
  expect(slashKeyAction({ upArrow: true, downArrow: false, tab: false, escape: false }, null)).toBeNull();
});

it("routes selection keys only while a completion menu is open", () => {
  expect(completionKeyAction(
    { upArrow: true, downArrow: false, tab: false, escape: false },
    true,
  )).toEqual({ type: "select", delta: -1 });
  expect(completionKeyAction(
    { upArrow: false, downArrow: true, tab: false, escape: false },
    true,
  )).toEqual({ type: "select", delta: 1 });
  expect(completionKeyAction(
    { upArrow: false, downArrow: false, tab: true, escape: false },
    true,
  )).toEqual({ type: "complete" });
  expect(completionKeyAction(
    { upArrow: false, downArrow: false, tab: false, escape: true },
    true,
  )).toEqual({ type: "dismiss" });
  expect(completionKeyAction(
    { upArrow: true, downArrow: false, tab: false, escape: false },
    false,
  )).toBeNull();
});
