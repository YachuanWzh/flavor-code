import { afterEach, describe, expect, it, vi } from "vitest";

import { createTranscriptState, transcriptReducer } from "../../src/ui/transcript.js";

afterEach(() => vi.useRealTimers());

describe("transcriptReducer", () => {
  it("hydrates retained user and assistant turns without tool output", () => {
    const state = transcriptReducer(createTranscriptState(), { type: "hydrate", messages: [
      { role: "user", content: "first question" },
      { role: "assistant", content: "checking" },
      { role: "tool", content: "very long tool output" },
      { role: "assistant", content: "first answer" },
      { role: "assistant", content: "" },
      { role: "user", content: "second question" },
    ] });

    expect(state.completed.map(({ id, prompt, assistantText, blocks }) => ({ id, prompt, assistantText, blocks }))).toEqual([
      { id: 1, prompt: "first question", assistantText: "checkingfirst answer", blocks: [{ kind: "text", text: "checkingfirst answer" }] },
      { id: 2, prompt: "second question", assistantText: "", blocks: [] },
    ]);
    expect(state.active).toBeUndefined();
    expect(state.nextId).toBe(3);
    expect(JSON.stringify(state)).not.toContain("very long tool output");
  });

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

  it("updates one model-neutral retry row with the five-attempt total", () => {
    let state = transcriptReducer(createTranscriptState(), { type: "submit", prompt: "recover" });
    state = transcriptReducer(state, { type: "session", event: {
      type: "model-retry", attempt: 2, maxAttempts: 5, delayMs: 1_000,
    } });
    state = transcriptReducer(state, { type: "session", event: {
      type: "model-retry", attempt: 4, maxAttempts: 5, delayMs: 4_000,
    } });

    expect(state.active?.blocks).toEqual([{
      kind: "status",
      id: "model-retry",
      state: "info",
      tone: "retry",
      text: "↻ Retrying model call · attempt 4/5 in 4s",
    }]);
    expect(JSON.stringify(state.active)).not.toMatch(/fake:model|cheap:small|terminated/i);
  });

  it("shows structured-output repair retries as a distinct retry row", () => {
    let state = transcriptReducer(createTranscriptState(), { type: "submit", prompt: "recover JSON" });
    state = transcriptReducer(state, { type: "session", event: {
      type: "structured-output-retry",
      tool: "write_file",
      modelId: "cheap:small",
      attempt: 2,
      maxAttempts: 4,
      delayMs: 1_000,
      error: "Invalid JSON",
    } });

    expect(state.active?.blocks).toEqual([{
      kind: "status",
      id: "structured-retry:write_file",
      state: "info",
      tone: "retry",
      text: "↻ Repairing write_file arguments · attempt 2/4 in 1s",
    }]);
    expect(JSON.stringify(state.active)).not.toContain("cheap:small");
  });

  it("updates one loop progress row through cycles, budget, and terminal state", () => {
    let state = transcriptReducer(createTranscriptState(), { type: "submit", prompt: "/loop fix tests" });
    state = transcriptReducer(state, { type: "session", event: {
      type: "loop-progress", loopId: "loop-one", phase: "cycle", state: "running", message: "Cycle 2 running",
    } });
    state = transcriptReducer(state, { type: "session", event: {
      type: "loop-progress", loopId: "loop-one", phase: "budget", state: "info", message: "Waiting for token budget approval",
    } });
    state = transcriptReducer(state, { type: "session", event: {
      type: "loop-progress", loopId: "loop-one", phase: "terminal", state: "completed", message: "Loop succeeded",
    } });

    expect(state.active?.blocks).toEqual([{
      kind: "status", id: "loop:loop-one", state: "completed", text: "Loop succeeded",
    }]);
  });

  it("updates compact progress in place instead of appending rows", () => {
    let state = transcriptReducer(createTranscriptState(), { type: "submit", prompt: "/compact" });
    state = transcriptReducer(state, { type: "session", event: { type: "compact-progress", progress: 10 } });
    state = transcriptReducer(state, { type: "session", event: { type: "compact-progress", progress: 40 } });

    expect(state.active?.blocks).toEqual([{
      kind: "status",
      id: "compact:progress",
      state: "running",
      text: "Compacting context",
      progress: 40,
    }]);
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

  it("renders an aborted subagent snapshot as cancelled instead of failed", () => {
    const worker = {
      id: "worker", description: "Inspect worker", dependencies: [],
      expectedOutputs: [], verification: [],
    };
    let state = transcriptReducer(createTranscriptState(), { type: "submit", prompt: "inspect" });
    state = transcriptReducer(state, { type: "session", event: {
      type: "tasks",
      snapshot: {
        subagents: { graph: { nodes: [worker] }, states: { worker: "cancelled" } },
      },
    } });

    expect(state.active?.blocks).toEqual([
      expect.objectContaining({
        id: "subagent:worker", state: "cancelled",
        text: "× subagent: Inspect worker · cancelled",
      }),
    ]);
  });

  it("labels completed and failed delegated task rows as subagents", () => {
    const nodes = ["done", "broken"].map((id) => ({
      id, description: `${id} worker`, dependencies: [], expectedOutputs: [], verification: [],
    }));
    let state = transcriptReducer(createTranscriptState(), { type: "submit", prompt: "workers" });
    state = transcriptReducer(state, { type: "session", event: {
      type: "tasks",
      snapshot: { subagents: { graph: { nodes }, states: { done: "completed", broken: "failed" } } },
    } });

    expect(state.active?.blocks).toEqual([
      expect.objectContaining({ text: "✓ subagent: done worker · completed" }),
      expect.objectContaining({ text: "× subagent: broken worker · failed" }),
    ]);
  });

  it("removes stale task and subagent rows when a replacement snapshot omits them", () => {
    const first = {
      id: "inspect", subject: "Inspect code", activeForm: "Inspecting code",
      status: "completed" as const, dependencies: [],
    };
    const oldWorker = {
      id: "old-worker", description: "Old worker", dependencies: [], expectedOutputs: [], verification: [],
    };
    const second = {
      id: "implement", subject: "Implement change", activeForm: "Implementing change",
      status: "pending" as const, dependencies: [],
    };
    let state = transcriptReducer(createTranscriptState(), { type: "submit", prompt: "work" });
    state = transcriptReducer(state, { type: "session", event: {
      type: "tasks",
      snapshot: {
        plan: { tasks: [first] },
        subagents: { graph: { nodes: [oldWorker] }, states: { "old-worker": "completed" } },
      },
    } });
    state = transcriptReducer(state, { type: "session", event: {
      type: "tasks", snapshot: { plan: { tasks: [second] }, subagents: { states: {} } },
    } });

    expect(state.active?.blocks).toEqual([
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

  it("freezes elapsed time of completed subagent when another subagent finishes later", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-13T00:00:00.000Z"));
    const workerA = {
      id: "a", description: "Worker A", dependencies: [],
      expectedOutputs: [], verification: [],
    };
    const workerB = {
      id: "b", description: "Worker B", dependencies: [],
      expectedOutputs: [], verification: [],
    };
    const nodes = [workerA, workerB];
    let state = transcriptReducer(createTranscriptState(), { type: "submit", prompt: "work" });

    // Both start running
    state = transcriptReducer(state, { type: "session", event: {
      type: "tasks",
      snapshot: { subagents: { graph: { nodes }, states: { a: "running", b: "running" } } },
    } });

    // Worker A completes at T=5s
    vi.setSystemTime(new Date("2026-07-13T00:00:05.000Z"));
    state = transcriptReducer(state, { type: "session", event: {
      type: "tasks",
      snapshot: { subagents: { graph: { nodes }, states: { a: "completed", b: "running" } } },
    } });
    expect(state.active?.blocks.find((b) => b.kind === "status" && b.id === "subagent:a")?.elapsedMs).toBe(5_000);

    // Worker B completes at T=12s — worker A's elapsed time must stay frozen at 5s
    vi.setSystemTime(new Date("2026-07-13T00:00:12.000Z"));
    state = transcriptReducer(state, { type: "session", event: {
      type: "tasks",
      snapshot: { subagents: { graph: { nodes }, states: { a: "completed", b: "completed" } } },
    } });

    expect(state.active?.blocks.find((b) => b.kind === "status" && b.id === "subagent:a")?.elapsedMs).toBe(5_000);
    expect(state.active?.blocks.find((b) => b.kind === "status" && b.id === "subagent:b")?.elapsedMs).toBe(12_000);
  });

  it("uses snapshot-provided startedAt and elapsedMs for subagent blocks", () => {
    const workerA = {
      id: "a", description: "Worker A", dependencies: [],
      expectedOutputs: [], verification: [],
    };
    const workerB = {
      id: "b", description: "Worker B", dependencies: [],
      expectedOutputs: [], verification: [],
    };
    const nodes = [workerA, workerB];
    let state = transcriptReducer(createTranscriptState(), { type: "submit", prompt: "work" });

    // Snapshot provides startedAt and elapsedMs from the backend
    state = transcriptReducer(state, { type: "session", event: {
      type: "tasks",
      snapshot: {
        subagents: {
          graph: { nodes },
          states: { a: "completed", b: "running" },
          startedAt: { a: 1_000, b: 5_000 },
          elapsedMs: { a: 40_000 },
        },
      },
    } });

    const blockA = state.active?.blocks.find((b) => b.kind === "status" && b.id === "subagent:a");
    expect(blockA?.startedAt).toBe(1_000);  // from snapshot.startedAt for terminal task with no prior
    expect(blockA?.elapsedMs).toBe(40_000); // frozen from snapshot.elapsedMs

    const blockB = state.active?.blocks.find((b) => b.kind === "status" && b.id === "subagent:b");
    expect(blockB?.startedAt).toBe(5_000);  // from snapshot.startedAt
    expect(blockB?.elapsedMs).toBeUndefined(); // running tasks have no elapsedMs
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

  it("stores the hint field on the tool-start block", () => {
    let state = transcriptReducer(createTranscriptState(), { type: "submit", prompt: "run" });
    state = transcriptReducer(state, { type: "session", event: {
      type: "tool-start", id: "1", name: "Glob", input: {}, hint: "pattern: **/*.ts",
    } });

    expect(state.active?.blocks).toEqual([
      { kind: "status", id: "tool:1", state: "running", text: "Glob", hint: "pattern: **/*.ts" },
    ]);
    expect(state.active?.statusLines).toEqual(["Glob"]);
  });

  it("stores the hint field on the tool-end block without merging into text", () => {
    let state = transcriptReducer(createTranscriptState(), { type: "submit", prompt: "run" });
    state = transcriptReducer(state, { type: "session", event: {
      type: "tool-start", id: "1", name: "Glob", input: {}, label: "src", hint: "pattern: **/*.ts",
    } });
    state = transcriptReducer(state, { type: "session", event: {
      type: "tool-end", id: "1", name: "Glob", label: "src", result: { ok: true, output: {} }, hint: "pattern: **/*.ts",
    } });

    expect(state.active?.blocks).toEqual([
      { kind: "status", id: "tool:1", state: "completed", text: "✓ Glob src", hint: "pattern: **/*.ts" },
    ]);
    expect(state.active?.statusLines).toEqual(["✓ Glob src"]);
  });

  it("omits hint when the event provides none", () => {
    let state = transcriptReducer(createTranscriptState(), { type: "submit", prompt: "run" });
    state = transcriptReducer(state, { type: "session", event: {
      type: "tool-end", id: "1", name: "Read", result: { ok: true, output: "x" },
    } });

    expect(state.active?.blocks).toEqual([
      { kind: "status", id: "tool:1", state: "completed", text: "✓ Read" },
    ]);
    expect("hint" in (state.active!.blocks[0] as object)).toBe(false);
  });
});
