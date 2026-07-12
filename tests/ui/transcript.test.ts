import { describe, expect, it } from "vitest";

import { createTranscriptState, transcriptReducer } from "../../src/ui/transcript.js";

describe("transcriptReducer", () => {
  it("shows a submitted prompt immediately and accumulates streamed text", () => {
    let state = createTranscriptState();
    state = transcriptReducer(state, { type: "submit", prompt: "你好" });

    expect(state.active).toMatchObject({ id: 1, prompt: "你好", assistantText: "" });

    state = transcriptReducer(state, { type: "session", event: { type: "text", text: "第一" } });
    state = transcriptReducer(state, { type: "session", event: { type: "text", text: "段" } });
    expect(state.active?.assistantText).toBe("第一段");
  });

  it("appends completed turns without replacing earlier content", () => {
    let state = createTranscriptState();
    state = transcriptReducer(state, { type: "submit", prompt: "one" });
    state = transcriptReducer(state, { type: "session", event: { type: "text", text: "first" } });
    state = transcriptReducer(state, { type: "session", event: { type: "done", usage: { inputTokens: 1, outputTokens: 2 } } });
    state = transcriptReducer(state, { type: "submit", prompt: "two" });
    state = transcriptReducer(state, { type: "session", event: { type: "text", text: "second" } });
    state = transcriptReducer(state, { type: "finish" });

    expect(state.completed.map(({ prompt, assistantText }) => ({ prompt, assistantText }))).toEqual([
      { prompt: "one", assistantText: "first" },
      { prompt: "two", assistantText: "second" },
    ]);
    expect(state.active).toBeUndefined();
  });

  it("retains the prompt and redacted submission error when submission fails", () => {
    let state = transcriptReducer(createTranscriptState(), { type: "submit", prompt: "keep me" });
    state = transcriptReducer(state, { type: "submit-error", message: "safe error" });

    expect(state.active).toBeUndefined();
    expect(state.completed[0]).toMatchObject({ prompt: "keep me", assistantText: "◆ safe error" });
  });

  it("formats tool state as terminal status lines", () => {
    let state = transcriptReducer(createTranscriptState(), { type: "submit", prompt: "run" });
    state = transcriptReducer(state, { type: "session", event: { type: "tool-start", id: "1", name: "Read", input: {} } });
    state = transcriptReducer(state, { type: "session", event: { type: "tool-end", id: "1", name: "Read", result: { ok: true, output: "ok" } } });

    expect(state.active?.statusLines).toEqual(["└ Read · running", "✦ Read · done"]);
  });

  it("preserves the chronological order of prose and tool status blocks", () => {
    let state = transcriptReducer(createTranscriptState(), { type: "submit", prompt: "ordered" });
    state = transcriptReducer(state, { type: "session", event: { type: "text", text: "before" } });
    state = transcriptReducer(state, { type: "session", event: { type: "tool-start", id: "1", name: "Read", input: {} } });
    state = transcriptReducer(state, { type: "session", event: { type: "text", text: "after" } });

    expect(state.active?.blocks).toEqual([
      { kind: "text", text: "before" },
      { kind: "status", text: "└ Read · running" },
      { kind: "text", text: "after" },
    ]);
  });

  it("clears committed and active display state", () => {
    let state = transcriptReducer(createTranscriptState(), { type: "submit", prompt: "gone" });
    state = transcriptReducer(state, { type: "session", event: { type: "text", text: "also gone" } });
    state = transcriptReducer(state, { type: "clear" });

    expect(state).toEqual({ completed: [], nextId: 1 });
  });
});
