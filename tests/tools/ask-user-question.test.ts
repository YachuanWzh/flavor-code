import { describe, expect, it, vi } from "vitest";

import {
  createAskUserQuestionTool,
  hookAnswersFromUpdatedInput,
  QuestionBridge,
  type AskUserQuestionHandler,
} from "../../src/tools/ask-user-question.js";

function handler(responses: Record<number, string>): AskUserQuestionHandler {
  return async (qs, _signal) => {
    const answers: Record<number, string> = {};
    for (let i = 0; i < qs.length; i++) {
      answers[i] = responses[i] ?? "";
    }
    return answers;
  };
}

describe("AskUserQuestion tool", () => {
  it("returns the handler result as output", async () => {
    const tool = createAskUserQuestionTool(handler({ 0: "yes", 1: "no" }));
    const result = await tool.execute(
      {
        questions: [
          { question: "Proceed?", header: "Confirmation", options: [{ label: "Yes", description: "Go ahead" }, { label: "No", description: "Stop" }] },
          { question: "Save?", header: "Save", options: [{ label: "Yes", description: "Save changes" }, { label: "No", description: "Discard" }] },
        ],
      },
      new AbortController().signal,
    );

    expect(result).toEqual({ 0: "yes", 1: "no" });
  });

  it("rejects a single question without options", async () => {
    const tool = createAskUserQuestionTool(handler({}));
    const result = tool.inputSchema.safeParse({
      questions: [{ question: "what?", header: "header" }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects more than four options per question", async () => {
    const tool = createAskUserQuestionTool(handler({}));
    const result = tool.inputSchema.safeParse({
      questions: [{
        question: "Pick", header: "Header",
        options: [
          { label: "A", description: "a" },
          { label: "B", description: "b" },
          { label: "C", description: "c" },
          { label: "D", description: "d" },
          { label: "E", description: "e" },
        ],
      }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects more than four questions", async () => {
    const tool = createAskUserQuestionTool(handler({}));
    const q = { question: "q?", header: "h", options: [{ label: "A", description: "a" }] };
    const result = tool.inputSchema.safeParse({ questions: [q, q, q, q, q] });
    expect(result.success).toBe(false);
  });

  it("rejects empty question or header text", async () => {
    const tool = createAskUserQuestionTool(handler({}));
    const r1 = tool.inputSchema.safeParse({
      questions: [{ question: "", header: "header", options: [{ label: "A", description: "a" }] }],
    });
    const r2 = tool.inputSchema.safeParse({
      questions: [{ question: "q?", header: "", options: [{ label: "A", description: "a" }] }],
    });
    expect(r1.success).toBe(false);
    expect(r2.success).toBe(false);
  });

  it("exposes name and paths correctly", () => {
    const tool = createAskUserQuestionTool(handler({}));
    expect(tool.name).toBe("AskUserQuestion");
    expect(tool.description).toContain("custom-input choice");
    expect(tool.paths({ questions: [] })).toEqual([]);
  });
});

describe("QuestionBridge", () => {
  it("does not reopen a local prompt after cancellation during a relay", async () => {
    let finish!: (value: undefined) => void;
    const bridge = new QuestionBridge(undefined, () => new Promise((resolve) => { finish = resolve; }));
    const controller = new AbortController();
    const pending = bridge.ask([{ question: "Proceed?", header: "Confirm", options: [{ label: "Yes", description: "Go" }] }], controller.signal);
    controller.abort(new Error("cancelled"));
    await expect(pending).rejects.toThrow("cancelled");
    finish(undefined);
    await Promise.resolve();
    expect(bridge.pending).toBeUndefined();
  });
  it("returns a hook-relayed answer without opening the local prompt", async () => {
    const qs = [{ question: "Proceed?", header: "Confirm", options: [{ label: "Yes", description: "Go" }] }];
    const bridge = new QuestionBridge(undefined, async (received) => {
      expect(received).toEqual(qs);
      return { 0: "Yes" };
    });

    await expect(bridge.ask(qs, new AbortController().signal)).resolves.toEqual({ 0: "Yes" });
    expect(bridge.pending).toBeUndefined();
  });

  it("falls back to the local prompt when the relay has no complete answer", async () => {
    const qs = [{ question: "Proceed?", header: "Confirm", options: [{ label: "Yes", description: "Go" }] }];
    const bridge = new QuestionBridge(undefined, async () => undefined);
    const promise = bridge.ask(qs, new AbortController().signal);
    await vi.waitFor(() => expect(bridge.pending).toEqual(qs));
    bridge.answer({ 0: "Yes" });
    await expect(promise).resolves.toEqual({ 0: "Yes" });
  });

  it("sends questions to ask and resolves when answered", async () => {
    const bridge = new QuestionBridge();
    const qs = [{ question: "Proceed?", header: "Confirm", options: [{ label: "Yes", description: "Go" }] }];
    const promise = bridge.ask(qs, new AbortController().signal);
    expect(bridge.pending).toEqual(qs);

    bridge.answer({ 0: "Yes" });
    const result = await promise;
    expect(result).toEqual({ 0: "Yes" });
    expect(bridge.pending).toBeUndefined();
  });

  it("rejects ask when one is already pending", async () => {
    const bridge = new QuestionBridge();
    const qs = [{ question: "Proceed?", header: "Confirm", options: [{ label: "Yes", description: "Go" }] }];
    bridge.ask(qs, new AbortController().signal);
    await expect(bridge.ask(qs, new AbortController().signal)).rejects.toThrow(/already pending/i);
  });

  it("rejects when aborted", async () => {
    const bridge = new QuestionBridge();
    const controller = new AbortController();
    const promise = bridge.ask(
      [{ question: "Proceed?", header: "Confirm", options: [{ label: "Yes", description: "Go" }] }],
      controller.signal,
    );
    controller.abort(new Error("cancelled"));
    await expect(promise).rejects.toThrow("cancelled");
    expect(bridge.pending).toBeUndefined();
  });

  it("cancel rejects the pending question", async () => {
    const bridge = new QuestionBridge();
    const promise = bridge.ask(
      [{ question: "Proceed?", header: "Confirm", options: [{ label: "Yes", description: "Go" }] }],
      new AbortController().signal,
    );
    bridge.cancel("no longer needed");
    await expect(promise).rejects.toThrow("no longer needed");
    expect(bridge.pending).toBeUndefined();
  });

  it("dispose cancels pending question", async () => {
    const bridge = new QuestionBridge();
    const promise = bridge.ask(
      [{ question: "Proceed?", header: "Confirm", options: [{ label: "Yes", description: "Go" }] }],
      new AbortController().signal,
    );
    bridge.dispose();
    await expect(promise).rejects.toThrow("disposed");
    expect(bridge.pending).toBeUndefined();
  });

  it("answer is a no-op when nothing is pending", () => {
    const bridge = new QuestionBridge();
    expect(() => bridge.answer({ 0: "nope" })).not.toThrow();
  });

  it("cancel is a no-op when nothing is pending", () => {
    const bridge = new QuestionBridge();
    expect(() => bridge.cancel()).not.toThrow();
  });
});

describe("hookAnswersFromUpdatedInput", () => {
  const qs = [
    { question: "Which aspect?", header: "Focus", options: [{ label: "Performance", description: "Speed" }] },
    { question: "Which style?", header: "Style", options: [{ label: "Minimal", description: "Less" }] },
  ];

  it("maps answers keyed by question text to question indexes", () => {
    const updatedInput = {
      tool: "AskUserQuestion",
      input: { questions: qs, answers: { "Which aspect?": "Performance", "Which style?": "Minimal" } },
      agent: "main",
    };
    expect(hookAnswersFromUpdatedInput(updatedInput, qs)).toEqual({ 0: "Performance", 1: "Minimal" });
  });

  it("returns undefined when an answer is missing or blank", () => {
    expect(hookAnswersFromUpdatedInput({ input: { answers: { "Which aspect?": "Performance" } } }, qs)).toBeUndefined();
    expect(hookAnswersFromUpdatedInput({ input: { answers: { "Which aspect?": "  ", "Which style?": "Minimal" } } }, qs)).toBeUndefined();
  });

  it("returns undefined for malformed updatedInput", () => {
    expect(hookAnswersFromUpdatedInput(undefined, qs)).toBeUndefined();
    expect(hookAnswersFromUpdatedInput({}, qs)).toBeUndefined();
    expect(hookAnswersFromUpdatedInput({ input: "nope" }, qs)).toBeUndefined();
    expect(hookAnswersFromUpdatedInput({ input: { answers: "nope" } }, qs)).toBeUndefined();
  });
});
