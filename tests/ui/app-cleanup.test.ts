import { expect, it, vi } from "vitest";
import type { ProductionRuntime } from "../../src/production.js";
import {
  promptDelivery,
  resolvePromptDelivery,
  runTerminalSubmissionChain,
  shutdownRuntime,
  PendingPromptQueue,
  PromptEditHistory,
  restoreQueuedPrompt,
  submitSafely,
} from "../../src/ui/app.js";

it("maps active CLI submissions to steering and Alt+Enter to follow-up", () => {
  expect(promptDelivery(false, { meta: false })).toBe("prompt");
  expect(promptDelivery(true, { meta: false })).toBe("followUp");
  expect(promptDelivery(true, { meta: true })).toBe("followUp");
});

it("supports a terminal-portable follow-up prefix while active", () => {
  expect(resolvePromptDelivery(true, { meta: false }, "/followup then add docs")).toEqual({
    delivery: "followUp",
    prompt: "then add docs",
  });
  expect(resolvePromptDelivery(true, { meta: false }, "/steer focus tests")).toEqual({
    delivery: "steer",
    prompt: "focus tests",
  });
});

it("queues multiple pending CLI prompts and returns the latest one for editing on cancel", () => {
  const pending = new PendingPromptQueue();
  expect(pending.queue("then add tests")).toBe(true);
  expect(pending.queue("/frontend-design refine the panel")).toBe(true);
  expect(pending.values.map(({ text }) => text)).toEqual(["then add tests", "/frontend-design refine the panel"]);
  expect(pending.cancel()?.text).toBe("/frontend-design refine the panel");
  expect(pending.values.map(({ text }) => text)).toEqual(["then add tests"]);
  expect(pending.take()?.text).toBe("then add tests");
  expect(pending.size).toBe(0);
});

it("undoes and redoes recent prompt edits while clearing redo after a new edit", () => {
  const history = new PromptEditHistory();
  const empty = { text: "", cursor: 0, pastedBlocks: [], imageAttachments: [] };
  const one = { ...empty, text: "a", cursor: 1 };
  const two = { ...empty, text: "ab", cursor: 2 };
  history.record(empty, one);
  history.record(one, two);

  expect(history.undo(two)).toMatchObject({ text: "a", cursor: 1 });
  expect(history.redo(one)).toMatchObject({ text: "ab", cursor: 2 });
  const restored = history.undo(two)!;
  history.record(restored, { ...restored, text: "ac", cursor: 2 });
  expect(history.redo({ ...restored, text: "ac", cursor: 2 })).toBeUndefined();
});

it("restores image attachments when the latest pending prompt is recalled", () => {
  const image = {
    type: "image" as const,
    source: { type: "file" as const, path: "pending.png" },
    mediaType: "image/png" as const,
    sha256: "b".repeat(64),
    bytes: 12,
  };
  const restored = restoreQueuedPrompt({
    text: "inspect this",
    displayText: "inspect this\n[Image #1]",
    content: [{ type: "text", text: "inspect this" }, image],
  });

  expect(restored).toEqual({ text: "inspect this", cursor: 12, pastedBlocks: [], imageAttachments: [image] });
});

it("automatically submits multiple pending prompts in entry order after the active run ends", async () => {
  const pending = new PendingPromptQueue();
  const submitted: string[] = [];
  const visible: string[] = [];
  await runTerminalSubmissionChain({
    session: {
      submit: async (prompt) => {
        submitted.push(prompt);
        if (prompt === "first") {
          pending.queue("/frontend-design refine the panel");
          pending.queue("/doctor");
        }
      },
    },
    initialPrompt: "first",
    pending,
    onStart: (prompt) => visible.push(`start:${prompt}`),
    onFinish: () => visible.push("finish"),
    onPendingConsumed: (remaining) => visible.push(`consumed:${remaining.length}`),
    report: (error) => visible.push(`error:${error}`),
  });

  expect(submitted).toEqual(["first", "/frontend-design refine the panel", "/doctor"]);
  expect(visible).toEqual([
    "start:first", "finish", "consumed:1",
    "start:/frontend-design refine the panel", "finish", "consumed:0",
    "start:/doctor", "finish",
  ]);
});

it("preserves images on both initial and pending prompts in a CLI submission chain", async () => {
  const pending = new PendingPromptQueue();
  const submitted: string[] = [];
  const visible: string[] = [];
  const image = {
    type: "image" as const,
    source: { type: "file" as const, path: "one.png" },
    mediaType: "image/png" as const,
    sha256: "a".repeat(64),
    bytes: 8,
  };
  await runTerminalSubmissionChain({
    session: { submit: async (input: string | { text: string; content: unknown[] }) => {
      submitted.push(typeof input === "string" ? `text:${input}` : `rich:${input.text}:${input.content.length}`);
      if (typeof input !== "string" && input.text === "inspect") {
        pending.queue({
          text: "compare",
          displayText: "compare\n[Image #1]",
          content: [{ type: "text", text: "compare" }, image],
        });
      }
    } },
    initialPrompt: "inspect",
    initialDisplayPrompt: "inspect\n[Image #1]",
    initialContent: [{ type: "text", text: "inspect" }, image],
    pending,
    onStart: (prompt) => visible.push(prompt),
    onFinish: () => undefined,
    onPendingConsumed: () => undefined,
    report: () => undefined,
  });

  expect(submitted).toEqual(["rich:inspect:2", "rich:compare:2"]);
  expect(visible).toEqual(["inspect\n[Image #1]", "compare\n[Image #1]"]);
});

it("disposes and exits exactly once when SessionEnd fails without leaking secrets", async () => {
  const dispose = vi.fn(async () => { throw new Error("dispose failed"); }); const exit = vi.fn(); const errors: string[] = [];
  const runtime = { session: { close: async () => { throw new Error("token=sk-secret-value"); } }, dispose } as unknown as ProductionRuntime;
  await shutdownRuntime(runtime, exit, (message) => errors.push(message));
  expect(dispose).toHaveBeenCalledOnce(); expect(exit).toHaveBeenCalledOnce();
  expect(errors.join(" ")).not.toContain("sk-secret-value");
  expect(errors.join(" ")).toContain("dispose failed");
});

it("turns fire-and-forget Stop failures into rendered errors", async () => {
  const errors: string[] = [];
  await submitSafely({ submit: async () => { throw new Error("Stop hook failed"); } }, "hello", (message) => errors.push(message));
  expect(errors).toEqual(["Stop hook failed"]);
});

it("force-exits when graceful disposal hangs past the shutdown watchdog", async () => {
  const exit = vi.fn();
  const errors: string[] = [];
  const forceExit = vi.fn();
  const hangingClose = vi.fn(() => new Promise<void>(() => undefined));
  const runtime = { session: { close: hangingClose }, dispose: vi.fn(async () => undefined) } as unknown as ProductionRuntime;
  await shutdownRuntime(runtime, exit, (message) => errors.push(message), { shutdownTimeoutMs: 25, forceExit });
  expect(exit).toHaveBeenCalledOnce();
  expect(errors.join(" ")).toContain("timed out");
  await vi.waitFor(() => expect(forceExit).toHaveBeenCalledOnce());
});

it("does not force-exit when disposal finishes within the watchdog", async () => {
  const exit = vi.fn();
  const forceExit = vi.fn();
  const runtime = { session: { close: async () => undefined }, dispose: async () => undefined } as unknown as ProductionRuntime;
  await shutdownRuntime(runtime, exit, () => undefined, { shutdownTimeoutMs: 250, forceExit });
  expect(exit).toHaveBeenCalledOnce();
  await new Promise((resolve) => setTimeout(resolve, 400));
  expect(forceExit).not.toHaveBeenCalled();
});
