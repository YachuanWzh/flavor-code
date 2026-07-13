import { afterEach, describe, expect, it, vi } from "vitest";

import { createTranscriptState, transcriptReducer } from "../../src/ui/transcript.js";

afterEach(() => vi.useRealTimers());

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

  it("updates a tool status in place by call id", () => {
    let state = transcriptReducer(createTranscriptState(), { type: "submit", prompt: "run" });
    state = transcriptReducer(state, { type: "session", event: { type: "tool-start", id: "1", name: "Read", input: {} } });
    state = transcriptReducer(state, { type: "session", event: { type: "tool-end", id: "1", name: "Read", result: { ok: true, output: "ok" } } });

    expect(state.active?.statusLines).toEqual(["✓ Read"]);
    expect(state.active?.blocks).toEqual([
      { kind: "status", id: "tool:1", state: "completed", text: "✓ Read" },
    ]);
  });

  it("stores successful file-change presentation on the completed tool block", () => {
    const presentation = {
      kind: "file-change" as const,
      operation: "update" as const,
      path: "notes.md",
      added: 1,
      removed: 1,
      lines: [
        { kind: "removed" as const, oldLine: 4, text: "old" },
        { kind: "added" as const, newLine: 4, text: "new" },
      ],
    };
    let state = transcriptReducer(createTranscriptState(), { type: "submit", prompt: "run" });
    state = transcriptReducer(state, { type: "session", event: { type: "text", text: "before" } });
    state = transcriptReducer(state, { type: "session", event: {
      type: "tool-start", id: "1", name: "Edit", input: {}, label: "notes.md",
    } });
    state = transcriptReducer(state, { type: "session", event: { type: "tool-end", id: "1", name: "Edit",
      label: "notes.md", result: { ok: true, output: { path: "notes.md" }, presentation },
    } });
    state = transcriptReducer(state, { type: "session", event: { type: "text", text: "after" } });

    expect(state.active?.blocks).toEqual([
      { kind: "text", text: "before" },
      { kind: "status", id: "tool:1", state: "completed", text: "✓ Edit notes.md", presentation },
      { kind: "text", text: "after" },
    ]);
  });

  it("marks a cancelled tool row cancelled instead of leaving it running", () => {
    let state = transcriptReducer(createTranscriptState(), { type: "submit", prompt: "run" });
    state = transcriptReducer(state, { type: "session", event: { type: "tool-start", id: "1", name: "Shell", input: {} } });
    state = transcriptReducer(state, { type: "session", event: {
      type: "tool-end", id: "1", name: "Shell",
      result: { ok: false, error: { code: "cancelled", message: "stop" } },
    } });
    expect(state.active?.blocks).toEqual([
      { kind: "status", id: "tool:1", state: "cancelled", text: "× Shell" },
    ]);
  });

  it("stores task snapshots before and during an active turn", () => {
    const snapshot = {
      plan: { tasks: [{
        id: "inspect", subject: "Inspect code", activeForm: "Inspecting code",
        status: "in_progress" as const, dependencies: [],
      }] },
      subagents: { states: {} },
      foregroundTaskId: "inspect",
    };
    let state = transcriptReducer(createTranscriptState(), { type: "session", event: { type: "tasks", snapshot } });
    expect(state.taskSnapshot).toEqual(snapshot);

    state = transcriptReducer(state, { type: "submit", prompt: "plan" });
    expect(state.active?.taskSnapshot).toEqual(snapshot);
    expect(state.active?.blocks).toEqual([expect.objectContaining({ id: "task:inspect", state: "running" })]);

    const completed = { ...snapshot, plan: { tasks: [{ ...snapshot.plan.tasks[0]!, status: "completed" as const }] } };
    state = transcriptReducer(state, { type: "session", event: { type: "tasks", snapshot: completed } });
    expect(state.active?.taskSnapshot).toEqual(completed);
    expect(state.taskSnapshot).toEqual(completed);
  });

  it("updates planned task rows in place by task id", () => {
    const planTask = {
      id: "inspect", subject: "Inspect code", activeForm: "Inspecting code",
      status: "pending" as const, dependencies: [],
    };
    let state = transcriptReducer(createTranscriptState(), { type: "submit", prompt: "plan" });
    state = transcriptReducer(state, { type: "session", event: {
      type: "tasks", snapshot: { plan: { tasks: [planTask] }, subagents: { states: {} } },
    } });
    state = transcriptReducer(state, { type: "session", event: {
      type: "tasks", snapshot: {
        plan: { tasks: [{ ...planTask, status: "in_progress" }] },
        subagents: { states: {} }, foregroundTaskId: "inspect",
      },
    } });

    expect(state.active?.blocks).toEqual([expect.objectContaining({
      kind: "status", id: "task:inspect", state: "running",
      task: { subject: "Inspect code", activeForm: "Inspecting code", role: "main" },
    })]);

    state = transcriptReducer(state, { type: "session", event: {
      type: "tasks", snapshot: {
        plan: { tasks: [{ ...planTask, status: "completed" }] }, subagents: { states: {} },
      },
    } });
    expect(state.active?.blocks).toEqual([expect.objectContaining({
      kind: "status", id: "task:inspect", state: "completed", text: "✓ Inspect code · done",
    })]);
  });

  it("retains completed task rows when a replacement plan removes them", () => {
    const first = {
      id: "inspect", subject: "Inspect code", activeForm: "Inspecting code",
      status: "completed" as const, dependencies: [],
    };
    const second = {
      id: "implement", subject: "Implement change", activeForm: "Implementing change",
      status: "pending" as const, dependencies: [],
    };
    let state = transcriptReducer(createTranscriptState(), { type: "submit", prompt: "work" });
    state = transcriptReducer(state, { type: "session", event: {
      type: "tasks", snapshot: { plan: { tasks: [first] }, subagents: { states: {} } },
    } });
    state = transcriptReducer(state, { type: "session", event: {
      type: "tasks", snapshot: { plan: { tasks: [second] }, subagents: { states: {} } },
    } });

    expect(state.active?.blocks).toEqual([
      expect.objectContaining({ id: "task:inspect", state: "completed" }),
      expect.objectContaining({ id: "task:implement", state: "info" }),
    ]);
  });

  it("retains elapsed time when a running task becomes terminal", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-13T00:00:00.000Z"));
    const task = {
      id: "test", subject: "Run tests", activeForm: "Running tests",
      status: "in_progress" as const, dependencies: [],
    };
    let state = transcriptReducer(createTranscriptState(), { type: "submit", prompt: "test" });
    state = transcriptReducer(state, { type: "session", event: {
      type: "tasks", snapshot: { plan: { tasks: [task] }, subagents: { states: {} }, foregroundTaskId: "test" },
    } });
    vi.setSystemTime(new Date("2026-07-13T00:00:08.000Z"));
    state = transcriptReducer(state, { type: "session", event: {
      type: "tasks", snapshot: { plan: { tasks: [{ ...task, status: "completed" }] }, subagents: { states: {} } },
    } });

    expect(state.active?.blocks).toEqual([expect.objectContaining({ id: "task:test", elapsedMs: 8_000 })]);
  });

  it("does not duplicate terminal task rows into a later unrelated turn", () => {
    const completed = {
      plan: { tasks: [{
        id: "inspect", subject: "Inspect code", activeForm: "Inspecting code",
        status: "completed" as const, dependencies: [],
      }] },
      subagents: { states: {} },
    };
    let state = transcriptReducer(createTranscriptState(), { type: "submit", prompt: "first" });
    state = transcriptReducer(state, { type: "session", event: { type: "tasks", snapshot: completed } });
    state = transcriptReducer(state, { type: "finish" });
    state = transcriptReducer(state, { type: "submit", prompt: "unrelated" });

    expect(state.completed[0]?.blocks).toEqual([expect.objectContaining({ id: "task:inspect", state: "completed" })]);
    expect(state.active?.blocks).toEqual([]);
  });

  it("does not replay an inherited completed row when a pending sibling starts in a new turn", () => {
    const inspect = {
      id: "inspect", subject: "Inspect code", activeForm: "Inspecting code",
      status: "completed" as const, dependencies: [],
    };
    const implement = {
      id: "implement", subject: "Implement change", activeForm: "Implementing change",
      status: "pending" as const, dependencies: ["inspect"],
    };
    const snapshot = { plan: { tasks: [inspect, implement] }, subagents: { states: {} } };
    let state = transcriptReducer(createTranscriptState(), { type: "submit", prompt: "first" });
    state = transcriptReducer(state, { type: "session", event: { type: "tasks", snapshot } });
    state = transcriptReducer(state, { type: "finish" });
    state = transcriptReducer(state, { type: "submit", prompt: "continue" });
    state = transcriptReducer(state, { type: "session", event: { type: "tasks", snapshot: {
      ...snapshot,
      plan: { tasks: [inspect, { ...implement, status: "in_progress" as const }] },
      foregroundTaskId: "implement",
    } } });

    expect(state.active?.blocks).toEqual([
      expect.objectContaining({ id: "task:implement", state: "running" }),
    ]);
  });

  it("preserves the chronological order of prose and tool status blocks", () => {
    let state = transcriptReducer(createTranscriptState(), { type: "submit", prompt: "ordered" });
    state = transcriptReducer(state, { type: "session", event: { type: "text", text: "before" } });
    state = transcriptReducer(state, { type: "session", event: { type: "tool-start", id: "1", name: "Read", input: {} } });
    state = transcriptReducer(state, { type: "session", event: { type: "text", text: "after" } });

    expect(state.active?.blocks).toEqual([
      { kind: "text", text: "before" },
      { kind: "status", id: "tool:1", state: "running", text: "Read" },
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
