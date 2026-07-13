import type { SessionOutput } from "./session.js";
import type { TaskSnapshot } from "../agent/types.js";

export interface TranscriptTurn {
  id: number;
  prompt: string;
  assistantText: string;
  statusLines: string[];
  blocks: TranscriptBlock[];
  taskSnapshot?: TaskSnapshot;
}

export type TranscriptBlock =
  | { kind: "text"; text: string }
  | {
    kind: "status";
    id: string;
    state: "running" | "completed" | "failed" | "cancelled" | "info";
    text: string;
    task?: { subject: string; activeForm: string; role: "main" | "subagent" };
  };

export interface TranscriptState {
  completed: TranscriptTurn[];
  active?: TranscriptTurn;
  nextId: number;
  taskSnapshot?: TaskSnapshot;
}

export type TranscriptAction =
  | { type: "submit"; prompt: string }
  | { type: "session"; event: SessionOutput }
  | { type: "submit-error"; message: string }
  | { type: "finish" }
  | { type: "clear" };

export function createTranscriptState(): TranscriptState {
  return { completed: [], nextId: 1 };
}

export function transcriptReducer(state: TranscriptState, action: TranscriptAction): TranscriptState {
  if (action.type === "clear") return createTranscriptState();
  if (action.type === "submit") {
    return {
      ...state,
      active: {
        id: state.nextId,
        prompt: action.prompt,
        assistantText: "",
        statusLines: [],
        blocks: [],
        ...(state.taskSnapshot === undefined ? {} : { taskSnapshot: state.taskSnapshot }),
      },
      nextId: state.nextId + 1,
    };
  }
  if (action.type === "finish") return finishActive(state);
  if (action.type === "submit-error") {
    if (state.active === undefined) return state;
    return finishActive({
      ...state,
      active: addText(state.active, `◆ ${action.message}`, true),
    });
  }

  const event = action.event;
  if (event.type === "clear") return createTranscriptState();
  if (event.type === "tasks") {
    const active = state.active === undefined ? undefined : applyTaskSnapshot(state.active, event.snapshot);
    return {
      ...state,
      taskSnapshot: event.snapshot,
      ...(active === undefined ? {} : { active }),
    };
  }
  if (event.type === "exit" || state.active === undefined) return state;
  if (event.type === "done") {
    const withUsage = upsertStatus(state, {
      kind: "status", id: `usage:${state.active.id}`, state: "info",
      text: `· ${event.usage.inputTokens} in · ${event.usage.outputTokens} out`,
    });
    return finishActive(withUsage);
  }
  if (event.type === "text") {
    return { ...state, active: addText(state.active, event.text) };
  }
  if (event.type === "tool-start") return upsertStatus(state, {
    kind: "status", id: `tool:${event.id}`, state: "running", text: `└ ${event.name} · running`,
  });
  if (event.type === "tool-end") return upsertStatus(state, {
    kind: "status", id: `tool:${event.id}`, state: event.result.ok ? "completed" : "failed",
    text: `${event.result.ok ? "✦" : "×"} ${event.name} · ${event.result.ok ? "done" : "failed"}`,
  });
  if (event.type === "notice") return upsertStatus(state, {
    kind: "status", id: `notice:${state.active.blocks.length}`, state: "info", text: `› ${event.message}`,
  });
  if (event.type === "error") {
    return { ...state, active: addText(state.active, `◆ ${event.error.code}: ${event.error.message}`, true) };
  }
  if (event.type === "usage") return state;
  if (event.type === "compacted") return upsertStatus(state, {
    kind: "status", id: `compact:${state.active.blocks.length}`, state: "info", text: "· Context compacted.",
  });
  return state;
}

function applyTaskSnapshot(turn: TranscriptTurn, snapshot: TaskSnapshot): TranscriptTurn {
  const taskBlocks: Array<Extract<TranscriptBlock, { kind: "status" }>> = [];
  for (const task of snapshot.plan?.tasks ?? []) {
    const state = task.status === "in_progress" ? "running"
      : task.status === "completed" ? "completed"
      : task.status === "cancelled" ? "cancelled"
      : task.status === "failed" || task.status === "blocked" ? "failed"
      : "info";
    const suffix = task.status === "completed" ? "done" : task.status.replace("_", " ");
    taskBlocks.push({
      kind: "status",
      id: `task:${task.id}`,
      state,
      text: `${state === "completed" ? "✓" : state === "failed" || state === "cancelled" ? "×" : "·"} ${task.subject} · ${suffix}`,
      task: { subject: task.subject, activeForm: task.activeForm, role: "main" },
    });
  }
  for (const node of snapshot.subagents.graph?.nodes ?? []) {
    const status = snapshot.subagents.states[node.id] ?? "pending";
    const state = status === "running" ? "running"
      : status === "completed" ? "completed"
      : status === "failed" || status === "blocked" ? "failed"
      : "info";
    taskBlocks.push({
      kind: "status",
      id: `subagent:${node.id}`,
      state,
      text: `${state === "completed" ? "✓" : state === "failed" ? "×" : "·"} ${node.description} · ${status}`,
      task: { subject: node.description, activeForm: node.description, role: "subagent" },
    });
  }

  const ids = new Set(taskBlocks.map((block) => block.id));
  const blocks = turn.blocks.filter((block) => block.kind !== "status"
    || (!block.id.startsWith("task:") && !block.id.startsWith("subagent:"))
    || ids.has(block.id));
  for (const block of taskBlocks) {
    const index = blocks.findIndex((current) => current.kind === "status" && current.id === block.id);
    if (index < 0) blocks.push(block);
    else blocks[index] = block;
  }
  return {
    ...turn,
    taskSnapshot: snapshot,
    blocks,
    statusLines: blocks.filter((block): block is Extract<TranscriptBlock, { kind: "status" }> => block.kind === "status")
      .map((block) => block.text),
  };
}

function upsertStatus(state: TranscriptState, block: Extract<TranscriptBlock, { kind: "status" }>): TranscriptState {
  if (state.active === undefined) return state;
  const blocks = [...state.active.blocks];
  const index = blocks.findIndex((item) => item.kind === "status" && item.id === block.id);
  if (index < 0) blocks.push(block);
  else blocks[index] = block;
  return { ...state, active: {
    ...state.active,
    statusLines: blocks.filter((item): item is Extract<TranscriptBlock, { kind: "status" }> => item.kind === "status")
      .map((item) => item.text),
    blocks,
  } };
}

function finishActive(state: TranscriptState): TranscriptState {
  if (state.active === undefined) return state;
  return {
    completed: [...state.completed, state.active],
    nextId: state.nextId,
    ...(state.taskSnapshot === undefined ? {} : { taskSnapshot: state.taskSnapshot }),
  };
}

function appendLine(text: string, line: string): string {
  return text.length === 0 || text.endsWith("\n") ? text + line : `${text}\n${line}`;
}

function addText(turn: TranscriptTurn, text: string, onNewLine = false): TranscriptTurn {
  const assistantText = onNewLine ? appendLine(turn.assistantText, text) : turn.assistantText + text;
  const blocks = [...turn.blocks];
  const last = blocks[blocks.length - 1];
  if (!onNewLine && last?.kind === "text") blocks[blocks.length - 1] = { kind: "text", text: last.text + text };
  else blocks.push({ kind: "text", text });
  return { ...turn, assistantText, blocks };
}
