import { expect, it } from "vitest";
import { EventEmitter } from "node:events";
import {
  completionKeyAction,
  editPrompt,
  editPromptWithPastedBlocks,
  navigateHistory,
  prepareCliSubmission,
  selectWheelScrollTarget,
  slashKeyAction,
  taskPanelViewportRows,
  removeLastCliImageOnBackspace,
} from "../../src/ui/app.js";
import type { ScrollBoxHandle } from "../../src/claude-ink/index.js";
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

it("backspace removes the latest pasted block when the cursor is directly after it", () => {
  const olderPaste = "older pasted line\nolder second line";
  const pasted = "first pasted line\nsecond pasted line";
  const prefix = `${olderPaste} keep `;

  expect(editPromptWithPastedBlocks(
    { text: `${prefix}${pasted}`, cursor: [...`${prefix}${pasted}`].length },
    { type: "backspace" },
    [{ id: 1, text: olderPaste }, { id: 2, text: pasted }],
  )).toEqual({
    text: prefix,
    cursor: [...prefix].length,
    pastedBlocks: [{ id: 1, text: olderPaste }],
  });
});

it("backspace on an empty CLI prompt removes the most recent image", () => {
  const images = [
    { type: "image" as const, source: { type: "file" as const, path: "one.png" }, mediaType: "image/png" as const, sha256: "a".repeat(64), bytes: 8 },
    { type: "image" as const, source: { type: "file" as const, path: "two.png" }, mediaType: "image/png" as const, sha256: "b".repeat(64), bytes: 8 },
  ];
  expect(removeLastCliImageOnBackspace("", 0, images)).toEqual({
    handled: true,
    images: [images[0]],
  });
  expect(removeLastCliImageOnBackspace("text", 4, images)).toEqual({
    handled: false,
    images,
  });
});

it("prepares image-only CLI prompts and rejects unsupported image deliveries", () => {
  const images = [
    { type: "image" as const, source: { type: "file" as const, path: "one.png" }, mediaType: "image/png" as const, sha256: "a".repeat(64), bytes: 8 },
  ];
  expect(prepareCliSubmission("", images, false)).toEqual({
    kind: "ready",
    text: "Analyze the attached image(s).",
    displayText: "Analyze the attached image(s).\n[Image #1]",
    content: [{ type: "text", text: "Analyze the attached image(s)." }, images[0]],
  });
  expect(prepareCliSubmission("/help", images, false)).toEqual({
    kind: "error",
    message: "Image attachments cannot be used with slash commands.",
  });
  expect(prepareCliSubmission("inspect", images, true)).toEqual({
    kind: "error",
    message: "Images can only be attached to a new prompt.",
  });
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

it("routes wheel input to the hovered task panel and otherwise to the transcript", () => {
  const transcript = { name: "transcript" } as unknown as ScrollBoxHandle;
  const tasks = { name: "tasks" } as unknown as ScrollBoxHandle;

  expect(selectWheelScrollTarget(transcript, tasks, true)).toBe(tasks);
  expect(selectWheelScrollTarget(transcript, tasks, false)).toBe(transcript);
  expect(selectWheelScrollTarget(transcript, null, true)).toBe(transcript);
});

it("caps task progress at one third of the terminal while reserving prompt rows", () => {
  expect(taskPanelViewportRows(24, 2, true)).toBe(8);
  expect(taskPanelViewportRows(12, 2, true)).toBe(4);
  expect(taskPanelViewportRows(6, 4, true)).toBe(1);
  expect(taskPanelViewportRows(24, 2, false)).toBe(0);
});
