import { expect, it, vi } from "vitest";
import type { ProductionRuntime } from "../../src/production.js";
import {
  promptDelivery,
  resolvePromptDelivery,
  runTerminalSubmissionChain,
  shutdownRuntime,
  SinglePendingPrompt,
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

it("keeps at most one pending CLI prompt and returns it for editing on cancel", () => {
  const pending = new SinglePendingPrompt();
  expect(pending.queue("then add tests")).toBe(true);
  expect(pending.queue("a second pending query")).toBe(false);
  expect(pending.value).toBe("then add tests");
  expect(pending.cancel()).toBe("then add tests");
  expect(pending.value).toBeUndefined();
});

it("automatically submits the single pending prompt after the active run ends", async () => {
  const pending = new SinglePendingPrompt();
  const submitted: string[] = [];
  const visible: string[] = [];
  await runTerminalSubmissionChain({
    session: {
      submit: async (prompt) => {
        submitted.push(prompt);
        if (prompt === "first") pending.queue("then add tests");
      },
    },
    initialPrompt: "first",
    pending,
    onStart: (prompt) => visible.push(`start:${prompt}`),
    onFinish: () => visible.push("finish"),
    onPendingConsumed: () => visible.push("consumed"),
    report: (error) => visible.push(`error:${error}`),
  });

  expect(submitted).toEqual(["first", "then add tests"]);
  expect(visible).toEqual([
    "start:first", "finish", "consumed",
    "start:then add tests", "finish",
  ]);
});

it("uses the multimodal submitter only for the first prompt in a CLI submission chain", async () => {
  const pending = new SinglePendingPrompt();
  const submitted: string[] = [];
  const visible: string[] = [];
  await runTerminalSubmissionChain({
    session: { submit: async (prompt) => { submitted.push(`text:${prompt}`); } },
    initialPrompt: "inspect",
    initialDisplayPrompt: "inspect\n[Image #1]",
    initialSubmit: async (prompt) => {
      submitted.push(`rich:${prompt}`);
      pending.queue("then add tests");
    },
    pending,
    onStart: (prompt) => visible.push(prompt),
    onFinish: () => undefined,
    onPendingConsumed: () => undefined,
    report: () => undefined,
  });

  expect(submitted).toEqual(["rich:inspect", "text:then add tests"]);
  expect(visible).toEqual(["inspect\n[Image #1]", "then add tests"]);
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
