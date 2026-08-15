import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createTranscriptState,
  restoreTranscriptState,
  transcriptReducer,
  type TranscriptBlock,
} from "../../src/ui/transcript.js";

afterEach(() => vi.useRealTimers());

describe("transcriptReducer", () => {
  it("opens an attributed pal turn for an idle task so model output has a destination", () => {
    let state = transcriptReducer(createTranscriptState(), { type: "session", event: {
      type: "pal-task", status: "received",
      senderId: "22222222-2222-4222-8222-222222222222", senderAlias: "backend",
      messageId: "33333333-3333-4333-8333-333333333333",
      taskId: "44444444-4444-4444-8444-444444444444", goal: "Expose the v2 API",
    } });
    state = transcriptReducer(state, { type: "session", event: { type: "text", text: "Starting now." } });

    expect(state.active).toMatchObject({
      prompt: "Expose the v2 API",
      source: { kind: "pal", alias: "backend", instanceId: "22222222-2222-4222-8222-222222222222" },
      assistantText: "Starting now.",
    });
  });

  it("shows a busy pal task as a distinct status without replacing the local prompt", () => {
    let state = transcriptReducer(createTranscriptState(), { type: "submit", prompt: "Keep fixing the frontend" });
    state = transcriptReducer(state, { type: "session", event: {
      type: "pal-task", status: "received",
      senderId: "22222222-2222-4222-8222-222222222222", senderAlias: "backend",
      messageId: "33333333-3333-4333-8333-333333333333",
      taskId: "44444444-4444-4444-8444-444444444444", goal: "Expose the v2 API",
    } });

    expect(state.active?.prompt).toBe("Keep fixing the frontend");
    expect(state.active?.blocks).toContainEqual(expect.objectContaining({
      kind: "status", state: "info", text: expect.stringContaining("PAL · backend (22222222)"),
      details: "Expose the v2 API",
    }));
  });

  it("represents the complete co-work lifecycle without turning peer content into local input", () => {
    const base = {
      type: "cowork-event" as const,
      senderId: "22222222-2222-4222-8222-222222222222", senderAlias: "backend",
      localId: "11111111-1111-4111-8111-111111111111",
      coWorkId: "55555555-5555-4555-8555-555555555555", epoch: 1,
      snapshot: { goal: "/exit", phase: "planning", integration: null },
    };
    let state = transcriptReducer(createTranscriptState(), { type: "session", event: {
      ...base, action: "PROPOSE", planHash: null,
    } });
    expect(state.active).toMatchObject({
      prompt: "/exit",
      source: { kind: "pal", alias: "backend", context: "CO-WORK PLANNING" },
    });
    expect(state.active?.blocks).toContainEqual(expect.objectContaining({ state: "running", text: expect.stringContaining("proposal") }));

    state = transcriptReducer(state, { type: "session", event: {
      ...base, action: "PLAN", planHash: "a".repeat(64),
    } });
    expect(state.active?.blocks).toContainEqual(expect.objectContaining({ state: "info", text: expect.stringContaining("plan updated") }));

    state = transcriptReducer(state, { type: "session", event: {
      ...base, action: "START", planHash: "a".repeat(64), snapshot: { ...base.snapshot, phase: "running" },
    } });
    expect(state.active?.blocks).toContainEqual(expect.objectContaining({ state: "running", text: expect.stringContaining("execution started") }));

    state = transcriptReducer(state, { type: "session", event: {
      ...base, action: "END", planHash: "a".repeat(64),
      snapshot: { ...base.snapshot, phase: "completed", integration: { passed: true, evidence: "All checks passed" } },
    } });
    expect(state.completed.at(-1)?.blocks).toContainEqual(expect.objectContaining({ state: "completed", details: "All checks passed" }));
    expect(state.completed.at(-1)?.prompt).toBe("/exit");
  });

  it("creates an execution turn for an idle START and a visible terminal turn for CANCEL", () => {
    const base = {
      type: "cowork-event" as const,
      senderId: "22222222-2222-4222-8222-222222222222", senderAlias: "backend",
      coWorkId: "55555555-5555-4555-8555-555555555555", epoch: 1,
      snapshot: { goal: "Ship compatibility", phase: "running" },
    };
    let state = transcriptReducer(createTranscriptState(), { type: "session", event: {
      ...base, action: "START", planHash: "a".repeat(64),
    } });
    expect(state.active).toMatchObject({ source: { context: "CO-WORK EXECUTION" }, prompt: "Ship compatibility" });

    state = transcriptReducer(createTranscriptState(), { type: "session", event: {
      ...base, action: "CANCEL", planHash: null, snapshot: { ...base.snapshot, phase: "cancelled" },
    } });
    expect(state.completed.at(-1)?.blocks).toContainEqual(expect.objectContaining({ state: "cancelled" }));
  });

  it("renders a broadcast FAIL as a failed terminal result with bounded evidence", () => {
    const state = transcriptReducer(createTranscriptState(), { type: "session", event: {
      type: "cowork-event", action: "FAIL", planHash: "a".repeat(64),
      senderId: "22222222-2222-4222-8222-222222222222", senderAlias: "backend",
      coWorkId: "55555555-5555-4555-8555-555555555555", epoch: 1,
      snapshot: {
        goal: "Ship compatibility", phase: "failed", integration: null,
        completionAssertions: [{ participantId: "22222222-2222-4222-8222-222222222222", passed: false, detail: "API tests failed" }],
      },
    } });
    expect(state.completed.at(-1)?.blocks).toContainEqual(expect.objectContaining({
      state: "failed", text: expect.stringContaining("failed"), details: "API tests failed",
    }));
  });

  it("bounds untrusted pal goal and terminal detail in the transcript", () => {
    const long = "x".repeat(2_000);
    let state = transcriptReducer(createTranscriptState(), { type: "session", event: {
      type: "pal-task", status: "received",
      senderId: "22222222-2222-4222-8222-222222222222", senderAlias: "backend",
      messageId: "33333333-3333-4333-8333-333333333333",
      taskId: "44444444-4444-4444-8444-444444444444", goal: long,
    } });
    expect(state.active?.prompt.length).toBeLessThan(300);
    expect(state.active?.prompt.endsWith("…")).toBe(true);

    state = transcriptReducer(state, { type: "session", event: {
      type: "cowork-event", action: "END", planHash: "a".repeat(64),
      senderId: "22222222-2222-4222-8222-222222222222", senderAlias: "backend",
      coWorkId: "55555555-5555-4555-8555-555555555555", epoch: 1,
      snapshot: { goal: long, phase: "completed", integration: { passed: false, evidence: long } },
    } });
    const terminal = state.completed.at(-1)?.blocks.find((block) => block.kind === "status" && block.id.includes("END"));
    expect(terminal?.kind === "status" ? terminal.details?.length : 0).toBeLessThan(300);
  });

  it("renders a turn deliverables summary from the structured event", () => {
    let state = transcriptReducer(createTranscriptState(), { type: "submit", prompt: "change" });
    state = transcriptReducer(state, { type: "session", event: { type: "deliverables", files: [
      { path: "src/a.ts", operation: "update", added: 3, removed: 1 },
    ] } });
    expect(state.active?.blocks[0]).toMatchObject({
      id: "deliverables:1",
      state: "completed",
      text: "Changed 1 file",
      details: "update src/a.ts (+3 -1)",
      presentation: {
        kind: "changeset",
        files: [{ path: "src/a.ts", operation: "update", added: 3, removed: 1 }],
      },
    });
  });
  it("hydrates retained turns and reconstructs tool calls by call id", () => {
    const state = transcriptReducer(createTranscriptState(), { type: "hydrate", messages: [
      { role: "user", content: "first question" },
      { role: "assistant", content: "checking", toolCalls: [{ id: "read-1", name: "Read", input: { path: "notes.md" } }] },
      { role: "tool", toolCallId: "read-1", content: JSON.stringify({ path: "notes.md", content: "hello" }) },
      { role: "assistant", content: "first answer" },
      { role: "assistant", content: "" },
      { role: "user", content: "second question" },
    ] });

    expect(state.completed.map(({ id, prompt, assistantText, blocks }) => ({ id, prompt, assistantText, blocks }))).toEqual([
      { id: 1, prompt: "first question", assistantText: "checkingfirst answer", blocks: [
        { kind: "text", text: "checking" },
        {
          kind: "status", id: "tool:read-1", state: "completed", text: "✓ Read",
          tool: {
            name: "Read",
            input: { path: "notes.md" },
            result: { ok: true, output: { path: "notes.md", content: "hello" } },
          },
        },
        { kind: "text", text: "first answer" },
      ] },
      { id: 2, prompt: "second question", assistantText: "", blocks: [] },
    ]);
    expect(state.active).toBeUndefined();
    expect(state.nextId).toBe(3);
  });

  it("prepends an explicit boundary and summary for legacy compacted history", () => {
    const state = transcriptReducer(createTranscriptState(), {
      type: "hydrate",
      compact: { summary: "Inspected the old implementation and identified two callers.", compactedAt: "2026-07-20T10:00:00.000Z" },
      messages: [{ role: "user", content: "continue" }],
    });

    expect(state.completed[0]).toMatchObject({
      kind: "compaction",
      prompt: "Earlier execution history was compacted",
      blocks: [expect.objectContaining({
        kind: "status",
        state: "info",
        tone: "warning",
        details: "Inspected the old implementation and identified two callers.",
      })],
    });
    expect(state.completed[1]).toMatchObject({ prompt: "continue" });
  });

  it("shows a submitted prompt immediately and accumulates streamed text", () => {
    let state = createTranscriptState();
    state = transcriptReducer(state, { type: "submit", prompt: "你好" });

    expect(state.active).toMatchObject({ id: 1, prompt: "你好", assistantText: "" });

    state = transcriptReducer(state, { type: "session", event: { type: "text", text: "第一" } });
    state = transcriptReducer(state, { type: "session", event: { type: "text", text: "段" } });
    expect(state.active?.assistantText).toBe("第一段");
  });

  it("opens a new visible turn when a queued prompt starts", () => {
    let state = transcriptReducer(createTranscriptState(), { type: "submit", prompt: "first" });
    state = transcriptReducer(state, {
      type: "session",
      event: { type: "done", usage: { inputTokens: 1, outputTokens: 1 } },
    });
    state = transcriptReducer(state, {
      type: "session",
      event: { type: "queued-prompt", prompt: "then add tests" },
    });

    expect(state.completed[0]?.prompt).toBe("first");
    expect(state.active).toMatchObject({ prompt: "then add tests", assistantText: "" });
  });

  it("keeps an attributed bounded remote origin when queued peer work later starts", () => {
    let state = transcriptReducer(createTranscriptState(), { type: "submit", prompt: "local work" });
    state = transcriptReducer(state, {
      type: "session",
      event: {
        type: "queued-remote-prompt", senderAlias: "backend", senderId: "22222222-2222-4222-8222-222222222222",
        prompt: "Expose the v2 API".repeat(100), context: "CO-WORK EXECUTION",
      },
    });

    expect(state.completed[0]?.prompt).toBe("local work");
    expect(state.active).toMatchObject({
      prompt: expect.stringMatching(/^Expose the v2 API/),
      source: { kind: "pal", alias: "backend", instanceId: "22222222-2222-4222-8222-222222222222", context: "CO-WORK EXECUTION" },
    });
    expect(state.active!.prompt.length).toBeLessThanOrEqual(240);
    expect(state.active!.prompt).not.toContain("trusted local broker");
  });

  it("creates a transient activity block when a model call starts", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-19T00:00:00.000Z"));
    let state = transcriptReducer(createTranscriptState(), { type: "submit", prompt: "wait" });

    state = transcriptReducer(state, { type: "session", event: { type: "model-start", id: "1" } });

    expect(state.active?.blocks).toEqual([{
      kind: "status",
      id: "model:1",
      state: "running",
      text: "Flavoring",
      activity: "model",
      startedAt: Date.parse("2026-07-19T00:00:00.000Z"),
    }]);
  });

  it("removes model activity as soon as visible text arrives", () => {
    let state = transcriptReducer(createTranscriptState(), { type: "submit", prompt: "wait" });
    state = transcriptReducer(state, { type: "session", event: { type: "model-start", id: "1" } });

    state = transcriptReducer(state, { type: "session", event: { type: "text", text: "answer" } });

    expect(state.active?.blocks).toEqual([{ kind: "text", text: "answer" }]);
    expect(state.active?.statusLines).toEqual([]);
  });

  it("ends tool-only activity and starts a fresh timer for the next model call", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-19T00:00:00.000Z"));
    let state = transcriptReducer(createTranscriptState(), { type: "submit", prompt: "use a tool" });
    state = transcriptReducer(state, { type: "session", event: { type: "model-start", id: "1" } });
    state = transcriptReducer(state, { type: "session", event: { type: "model-end", id: "1" } });
    expect(state.active?.blocks).toEqual([]);

    vi.setSystemTime(new Date("2026-07-19T00:00:06.000Z"));
    state = transcriptReducer(state, { type: "session", event: { type: "model-start", id: "2" } });

    expect(state.active?.blocks).toEqual([expect.objectContaining({
      id: "model:2",
      activity: "model",
      startedAt: Date.parse("2026-07-19T00:00:06.000Z"),
    })]);
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
      {
        kind: "status", id: "tool:1", state: "completed", text: "✓ Read",
        tool: { name: "Read", input: {}, result: { ok: true, output: "ok" } },
      },
    ]);
  });

  it("normalizes an interrupted restored turn instead of leaving activity running", () => {
    const state = restoreTranscriptState({
      completed: [],
      active: {
        id: 1,
        prompt: "interrupted",
        assistantText: "",
        statusLines: ["Flavoring", "Shell npm test"],
        blocks: [
          { kind: "status", id: "model:1", state: "running", text: "Flavoring", activity: "model" },
          { kind: "status", id: "tool:1", state: "running", text: "Shell npm test", tool: { name: "Shell", input: { command: "npm test" } } },
        ],
      },
      nextId: 2,
    });

    expect(state.active).toBeUndefined();
    expect(state.completed[0]?.blocks).toEqual([
      expect.objectContaining({ id: "tool:1", state: "cancelled", tool: expect.objectContaining({ name: "Shell" }) }),
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
    state = transcriptReducer(state, { type: "session", event: { type: "compact-progress", progress: 100 } });

    expect(state.active?.blocks).toEqual([{
      kind: "status",
      id: "compact:progress",
      state: "completed",
      text: "Compacting context",
      progress: 100,
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
      {
        kind: "status", id: "tool:1", state: "completed", text: "✓ Edit notes.md", presentation,
        tool: { name: "Edit", input: {}, result: { ok: true, output: { path: "notes.md" }, presentation } },
      },
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
      {
        kind: "status", id: "tool:1", state: "cancelled", text: "× Shell",
        tool: { name: "Shell", input: {}, result: { ok: false, error: { code: "cancelled", message: "stop" } } },
      },
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

  it("archives current task rows but does not carry a closed plan into the next prompt", () => {
    const snapshot = {
      plan: { tasks: [{
        id: "inspect", subject: "Inspect code", activeForm: "Inspecting code",
        status: "pending" as const, dependencies: [],
      }] },
      subagents: { states: {} },
    };
    let state = transcriptReducer(createTranscriptState(), { type: "submit", prompt: "first" });
    state = transcriptReducer(state, { type: "session", event: { type: "tasks", snapshot } });
    state = transcriptReducer(state, { type: "session", event: { type: "tasks-cleared" } });
    state = transcriptReducer(state, { type: "finish" });

    expect(state.completed[0]?.blocks).toContainEqual(expect.objectContaining({ id: "task:inspect" }));
    expect(state.taskSnapshot).toBeUndefined();

    state = transcriptReducer(state, { type: "submit", prompt: "second" });
    expect(state.active?.blocks).toEqual([]);
    expect(state.active?.taskSnapshot).toBeUndefined();
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
    expect(state.active?.blocks.find(
      (b): b is Extract<TranscriptBlock, { kind: "status" }> => b.kind === "status" && b.id === "subagent:a",
    )?.elapsedMs).toBe(5_000);

    // Worker B completes at T=12s — worker A's elapsed time must stay frozen at 5s
    vi.setSystemTime(new Date("2026-07-13T00:00:12.000Z"));
    state = transcriptReducer(state, { type: "session", event: {
      type: "tasks",
      snapshot: { subagents: { graph: { nodes }, states: { a: "completed", b: "completed" } } },
    } });

    expect(state.active?.blocks.find(
      (b): b is Extract<TranscriptBlock, { kind: "status" }> => b.kind === "status" && b.id === "subagent:a",
    )?.elapsedMs).toBe(5_000);
    expect(state.active?.blocks.find(
      (b): b is Extract<TranscriptBlock, { kind: "status" }> => b.kind === "status" && b.id === "subagent:b",
    )?.elapsedMs).toBe(12_000);
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

    const blockA = state.active?.blocks.find(
      (b): b is Extract<TranscriptBlock, { kind: "status" }> => b.kind === "status" && b.id === "subagent:a",
    );
    expect(blockA?.startedAt).toBe(1_000);  // from snapshot.startedAt for terminal task with no prior
    expect(blockA?.elapsedMs).toBe(40_000); // frozen from snapshot.elapsedMs

    const blockB = state.active?.blocks.find(
      (b): b is Extract<TranscriptBlock, { kind: "status" }> => b.kind === "status" && b.id === "subagent:b",
    );
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
      { kind: "status", id: "tool:1", state: "running", text: "Read", tool: { name: "Read", input: {} } },
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
      {
        kind: "status", id: "tool:1", state: "running", text: "Glob", hint: "pattern: **/*.ts",
        tool: { name: "Glob", input: {} },
      },
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
      {
        kind: "status", id: "tool:1", state: "completed", text: "✓ Glob src", hint: "pattern: **/*.ts",
        tool: { name: "Glob", input: {}, result: { ok: true, output: {} } },
      },
    ]);
    expect(state.active?.statusLines).toEqual(["✓ Glob src"]);
  });

  it("omits hint when the event provides none", () => {
    let state = transcriptReducer(createTranscriptState(), { type: "submit", prompt: "run" });
    state = transcriptReducer(state, { type: "session", event: {
      type: "tool-end", id: "1", name: "Read", result: { ok: true, output: "x" },
    } });

    expect(state.active?.blocks).toEqual([
      {
        kind: "status", id: "tool:1", state: "completed", text: "✓ Read",
        tool: { name: "Read", input: null, result: { ok: true, output: "x" } },
      },
    ]);
    expect("hint" in (state.active!.blocks[0] as object)).toBe(false);
  });

  it("shows cache hit percentage and hint when done usage carries cache tokens", () => {
    let state = transcriptReducer(createTranscriptState(), { type: "submit", prompt: "cached" });
    state = transcriptReducer(state, { type: "session", event: { type: "text", text: "ok" } });
    state = transcriptReducer(state, {
      type: "session",
      event: {
        type: "done",
        usage: { inputTokens: 25000, outputTokens: 456, cacheReadTokens: 23000, cacheCreationTokens: 2000 },
      },
    });

    expect(state.active).toBeUndefined();
    expect(state.completed[0]?.blocks).toEqual([
      { kind: "text", text: "ok" },
      {
        kind: "status",
        id: "usage:1",
        state: "info",
        text: "· 25000 in · 92% cached · 456 out",
        hint: "cache 23000/25000",
      },
    ]);
  });

  it("keeps the plain token format when done usage has no cache fields", () => {
    let state = transcriptReducer(createTranscriptState(), { type: "submit", prompt: "plain" });
    state = transcriptReducer(state, { type: "session", event: { type: "text", text: "y" } });
    state = transcriptReducer(state, {
      type: "session",
      event: { type: "done", usage: { inputTokens: 12345, outputTokens: 67 } },
    });

    expect(state.completed[0]?.blocks).toContainEqual(
      expect.objectContaining({ id: "usage:1", text: "· 12345 in · 67 out" }),
    );
  });

  it("renders 0% cached without division by zero when input tokens are zero", () => {
    let state = transcriptReducer(createTranscriptState(), { type: "submit", prompt: "edge" });
    state = transcriptReducer(state, { type: "session", event: { type: "text", text: "x" } });
    state = transcriptReducer(state, {
      type: "session",
      event: { type: "done", usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 } },
    });

    expect(state.completed[0]?.blocks).toContainEqual(
      expect.objectContaining({ id: "usage:1", text: "· 0 in · 0% cached · 0 out" }),
    );
  });
});
