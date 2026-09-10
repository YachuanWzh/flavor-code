import { expect, it } from "vitest";
import { EventEmitter } from "node:events";
import {
  canShowSlashCompletion,
  completionKeyAction,
  editPrompt,
  editPromptWithPastedBlocks,
  isCopyShortcut,
  isPlatformShortcut,
  navigateHistory,
  navigatePromptHistory,
  prepareCliSubmission,
  promptHistoryAction,
  selectWheelScrollTarget,
  slashKeyAction,
  taskPanelViewportRows,
  removeLastCliImageOnBackspace,
  reverseSearchHistory,
  runningEscapeAction,
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

it("stashes the complete draft while browsing history and restores it at the end", () => {
  const image = { type: "image" as const, source: { type: "file" as const, path: "draft.png" }, mediaType: "image/png" as const, sha256: "a".repeat(64), bytes: 8 };
  const current = { text: "unfinished draft", cursor: 4, pastedBlocks: [{ id: 1, text: "draft" }], imageAttachments: [image] };
  const recalled = navigatePromptHistory({ history: ["one", "two"], cursor: 2, current }, "up");
  expect(recalled.draft).toMatchObject({ text: "two", cursor: 3, pastedBlocks: [], imageAttachments: [] });
  expect(recalled.stashed).toEqual(current);

  const restored = navigatePromptHistory({ history: ["one", "two"], cursor: recalled.cursor, current: recalled.draft, stashed: recalled.stashed! }, "down");
  expect(restored.cursor).toBe(2);
  expect(restored.draft).toEqual(current);
  expect(restored.draft).not.toBe(current);
});

it("searches history backwards and repeats from the previous match", () => {
  const history = ["fix login", "add tests", "fix logout", "ship release"];
  const latest = reverseSearchHistory(history, "FIX");
  expect(latest).toEqual({ cursor: 2, input: "fix logout", promptCursor: 10 });
  expect(reverseSearchHistory(history, "fix", latest!.cursor)).toEqual({ cursor: 0, input: "fix login", promptCursor: 9 });
  expect(reverseSearchHistory(history, "missing")).toBeUndefined();
});

it("uses Escape to recover a queued prompt first and interrupt otherwise", () => {
  expect(runningEscapeAction(true, 2)).toBe("restore-pending");
  expect(runningEscapeAction(true, 0)).toBe("interrupt");
  expect(runningEscapeAction(false, 0)).toBeNull();
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

it("uses Command+C for copy on macOS and Ctrl+C elsewhere", () => {
  expect(isCopyShortcut("c", { ctrl: true, super: false }, "win32")).toBe(true);
  expect(isCopyShortcut("c", { ctrl: true, super: false }, "darwin")).toBe(false);
  expect(isCopyShortcut("c", { ctrl: false, super: true }, "darwin")).toBe(true);
});

it("supports platform-native history and output shortcuts on macOS, Windows, and Linux", () => {
  expect(isPlatformShortcut("o", { ctrl: true, super: false }, "o", "win32")).toBe(true);
  expect(isPlatformShortcut("r", { ctrl: true, super: false }, "r", "linux")).toBe(true);
  expect(isPlatformShortcut("O", { ctrl: false, super: true }, "o", "darwin")).toBe(true);
  expect(isPlatformShortcut("r", { ctrl: false, super: true }, "r", "darwin")).toBe(true);
  expect(isPlatformShortcut("o", { ctrl: true, super: false }, "o", "darwin")).toBe(true);
  expect(isPlatformShortcut("x", { ctrl: false, super: true }, "o", "darwin")).toBe(false);
  expect(isPlatformShortcut("o", { ctrl: false, super: true }, "o", "win32")).toBe(false);
});

it("maps platform-native undo and redo shortcuts", () => {
  expect(promptHistoryAction("z", { ctrl: true, shift: false, super: false }, "win32")).toBe("undo");
  expect(promptHistoryAction("Z", { ctrl: true, shift: true, super: false }, "linux")).toBe("redo");
  expect(promptHistoryAction("z", { ctrl: false, shift: false, super: true }, "darwin")).toBe("undo");
  expect(promptHistoryAction("z", { ctrl: false, shift: true, super: true }, "darwin")).toBe("redo");
  expect(promptHistoryAction("z", { ctrl: true, shift: false, super: false }, "darwin")).toBeNull();
});

it("prepares images for new and pending prompts while rejecting slash-command attachments", () => {
  const images = [
    { type: "image" as const, source: { type: "file" as const, path: "one.png" }, mediaType: "image/png" as const, sha256: "a".repeat(64), bytes: 8 },
  ];
  expect(prepareCliSubmission("", images)).toEqual({
    kind: "ready",
    text: "Analyze the attached image(s).",
    displayText: "Analyze the attached image(s).\n[Image #1]",
    content: [{ type: "text", text: "Analyze the attached image(s)." }, images[0]],
  });
  expect(prepareCliSubmission("/help", images)).toEqual({
    kind: "error",
    message: "Image attachments cannot be used with slash commands.",
  });
  expect(prepareCliSubmission("inspect", images)).toEqual({
    kind: "ready",
    text: "inspect",
    displayText: "inspect\n[Image #1]",
    content: [{ type: "text", text: "inspect" }, images[0]],
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

it("keeps slash completion available while an agent is producing output", () => {
  expect(canShowSlashCompletion(true, "/", undefined, false)).toBe(true);
  expect(canShowSlashCompletion(false, "/", undefined, false)).toBe(true);
  expect(canShowSlashCompletion(true, "/", "/", false)).toBe(false);
  expect(canShowSlashCompletion(true, "/", undefined, true)).toBe(false);
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

it("routes wheel input to the independently hovered task track and otherwise to the transcript", () => {
  const transcript = { name: "transcript" } as unknown as ScrollBoxHandle;
  const mainTasks = { name: "main-tasks" } as unknown as ScrollBoxHandle;
  const subagentTasks = { name: "subagent-tasks" } as unknown as ScrollBoxHandle;

  expect(selectWheelScrollTarget(transcript, mainTasks, subagentTasks, "main")).toBe(mainTasks);
  expect(selectWheelScrollTarget(transcript, mainTasks, subagentTasks, "subagent")).toBe(subagentTasks);
  expect(selectWheelScrollTarget(transcript, mainTasks, subagentTasks, null)).toBe(transcript);
  expect(selectWheelScrollTarget(transcript, null, subagentTasks, "main")).toBe(transcript);
});

it("caps task progress at one third of the terminal while reserving prompt rows", () => {
  expect(taskPanelViewportRows(24, 2, true)).toBe(8);
  expect(taskPanelViewportRows(12, 2, true)).toBe(4);
  expect(taskPanelViewportRows(6, 4, true)).toBe(1);
  expect(taskPanelViewportRows(24, 2, false)).toBe(0);
});
