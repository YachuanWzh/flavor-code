import { describe, expect, it } from "vitest";

import {
  createAskUserQuestionTool,
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
    expect(tool.paths({ questions: [] })).toEqual([]);
  });
});

describe("QuestionBridge", () => {
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
