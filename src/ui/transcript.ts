import type { SessionOutput } from "./session.js";
import type { TaskSnapshot } from "../agent/types.js";
import type { ToolPresentation } from "../tools/types.js";

export interface TranscriptTurn {
  id: number;
  kind?: "compaction";
  prompt: string;
  assistantText: string;
  statusLines: string[];
  blocks: TranscriptBlock[];
  taskSnapshot?: TaskSnapshot;
  suppressedTaskIds?: string[];
}

export interface TranscriptHistoryMessage {
  readonly role: "user" | "assistant" | "tool";
  readonly content: string;
  readonly toolCallId?: string | undefined;
  readonly toolCalls?: readonly { id: string; name: string; input: unknown }[] | undefined;
}

export interface TranscriptCompactBoundary {
  readonly summary: string;
  readonly compactedAt: string;
}

export interface TranscriptToolDetails {
  readonly name: string;
  readonly input: unknown;
  readonly result?: import("../tools/types.js").ToolResult;
}

export type TranscriptBlock =
  | { kind: "text"; text: string }
  | {
    kind: "status";
    id: string;
    state: "running" | "completed" | "failed" | "cancelled" | "info";
    tone?: "retry" | "warning";
    text: string;
    hint?: string;
    task?: { subject: string; activeForm: string; role: "main" | "subagent" };
    activity?: "model";
    presentation?: ToolPresentation;
    tool?: TranscriptToolDetails;
    details?: string;
    progress?: number;
    startedAt?: number;
    elapsedMs?: number;
  };

export interface TranscriptState {
  completed: TranscriptTurn[];
  active?: TranscriptTurn;
  nextId: number;
  taskSnapshot?: TaskSnapshot;
}

export type TranscriptAction =
  | { type: "hydrate"; messages: readonly TranscriptHistoryMessage[]; compact?: TranscriptCompactBoundary }
  | { type: "restore"; state: TranscriptState }
  | { type: "submit"; prompt: string }
  | { type: "session"; event: SessionOutput }
  | { type: "submit-error"; message: string }
  | { type: "finish" }
  | { type: "clear" };

export function createTranscriptState(): TranscriptState {
  return { completed: [], nextId: 1 };
}

export function transcriptReducer(state: TranscriptState, action: TranscriptAction): TranscriptState {
  if (action.type === "hydrate") return hydrateHistory(action.messages, action.compact);
  if (action.type === "restore") return restoreTranscriptState(action.state);
  if (action.type === "clear") return createTranscriptState();
  if (action.type === "submit") {
    const active: TranscriptTurn = {
      id: state.nextId,
      prompt: action.prompt,
      assistantText: "",
      statusLines: [],
      blocks: [],
      ...(state.taskSnapshot === undefined ? {} : { taskSnapshot: state.taskSnapshot }),
      ...(state.taskSnapshot === undefined ? {} : { suppressedTaskIds: terminalTaskIds(state.taskSnapshot) }),
    };
    return {
      ...state,
      active: state.taskSnapshot === undefined ? active : applyTaskSnapshot(active, state.taskSnapshot, false),
      nextId: state.nextId + 1,
    };
  }
  if (action.type === "finish") return finishActive(state);
  if (action.type === "submit-error") {
    if (state.active === undefined) return state;
    return finishActive({
      ...state,
      active: addText(withoutModelActivity(state.active), `◆ ${action.message}`, true),
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
  if (event.type === "model-start") return upsertStatus({
    ...state,
    active: withoutModelActivity(state.active),
  }, {
    kind: "status",
    id: `model:${event.id}`,
    state: "running",
    text: "Flavoring",
    activity: "model",
    startedAt: Date.now(),
  });
  if (event.type === "model-end") return {
    ...state,
    active: withoutModelActivity(state.active, `model:${event.id}`),
  };
  if (event.type === "done") {
    const withUsage = upsertStatus({ ...state, active: withoutModelActivity(state.active) }, {
      kind: "status", id: `usage:${state.active.id}`, state: "info",
      text: `· ${event.usage.inputTokens} in · ${event.usage.outputTokens} out`,
    });
    return finishActive(withUsage);
  }
  if (event.type === "text") {
    return { ...state, active: addText(withoutModelActivity(state.active), event.text) };
  }
  if (event.type === "tool-start") return upsertStatus({ ...state, active: withoutModelActivity(state.active) }, {
    kind: "status", id: `tool:${event.id}`, state: "running", text: `${event.name}${event.label ? ` ${event.label}` : ""}`,
    ...(event.hint === undefined ? {} : { hint: event.hint }),
    tool: { name: event.name, input: event.input },
  });
  if (event.type === "tool-end") {
    const cancelled = !event.result.ok && event.result.error?.code === "cancelled";
    const previous = state.active.blocks.find((block) => block.kind === "status" && block.id === `tool:${event.id}`);
    const input = previous?.kind === "status" && previous.tool !== undefined ? previous.tool.input : null;
    return upsertStatus(state, {
      kind: "status",
      id: `tool:${event.id}`,
      state: event.result.ok ? "completed" : cancelled ? "cancelled" : "failed",
      text: `${event.result.ok ? "✓" : "×"} ${event.name}${event.label ? ` ${event.label}` : ""}`,
      ...(event.hint === undefined ? {} : { hint: event.hint }),
      ...(event.result.ok && event.result.presentation !== undefined
        ? { presentation: event.result.presentation }
        : {}),
      tool: { name: event.name, input, result: event.result },
    });
  }
  if (event.type === "notice") return upsertStatus(state, {
    kind: "status", id: `notice:${state.active.blocks.length}`, state: "info", text: `· ${event.message}`,
  });
  if (event.type === "compact-progress") {
    const progress = Math.max(0, Math.min(100, Math.floor(event.progress / 10) * 10));
    return upsertStatus(state, {
      kind: "status",
      id: "compact:progress",
      state: progress === 100 ? "completed" : "running",
      text: "Compacting context",
      progress,
    });
  }
  if (event.type === "error") {
    const withoutActivity = withoutModelActivity(state.active);
    const active = event.error.code === "cancelled"
      ? stripRetryBlocks(withoutActivity)
      : withoutActivity;
    return { ...state, active: addText(active, `◆ ${event.error.code}: ${event.error.message}`, true) };
  }
  if (event.type === "usage") return state;
  if (event.type === "model-retry") return upsertStatus({ ...state, active: withoutModelActivity(state.active) }, {
    kind: "status",
    id: "model-retry",
    state: "info",
    tone: "retry",
    text: `↻ Retrying model call · attempt ${event.attempt}/${event.maxAttempts} in ${event.delayMs / 1_000}s`,
  });
  if (event.type === "structured-output-retry") return upsertStatus(state, {
    kind: "status",
    id: `structured-retry:${event.tool}`,
    state: "info",
    tone: "retry",
    text: `↻ Repairing ${event.tool} arguments · attempt ${event.attempt}/${event.maxAttempts} in ${event.delayMs / 1_000}s`,
  });
  if (event.type === "loop-progress") return upsertStatus(state, {
    kind: "status",
    id: `loop:${event.loopId}`,
    state: event.state,
    text: event.message,
  });
  if (event.type === "compacted") return upsertStatus(state, {
    kind: "status", id: `compact:${state.active.blocks.length}`, state: "info", text: "· Context compacted.",
  });
  if (event.type === "warning") return upsertStatus(state, {
    kind: "status", id: `warn:${state.active.blocks.length}`, state: "info", tone: "warning", text: `⚠ ${event.message}`,
  });
  if (event.type === "limit_reached") {
    const suffix = event.extended ? " — auto-extended" : "";
    return upsertStatus(state, {
      kind: "status", id: `limit:${state.active.blocks.length}`, state: event.extended ? "info" : "failed",
      text: `◆ Iteration limit ${event.maxIterations} reached at round ${event.iteration}${suffix}`,
    });
  }
  return state;
}

function hydrateHistory(
  messages: readonly TranscriptHistoryMessage[],
  compact?: TranscriptCompactBoundary,
): TranscriptState {
  const completed: TranscriptTurn[] = [];
  if (compact !== undefined) completed.push(compactionTurn(compact));
  let turn: TranscriptTurn | undefined;
  for (const message of messages) {
    if (message.role === "user") {
      if (turn !== undefined) completed.push(turn);
      turn = {
        id: completed.length + 1,
        prompt: message.content,
        assistantText: "",
        statusLines: [],
        blocks: [],
      };
    } else if (message.role === "assistant" && turn !== undefined) {
      if (message.content.length > 0) turn = addText(turn, message.content);
      for (const call of message.toolCalls ?? []) {
        turn = upsertTurnStatus(turn, {
          kind: "status",
          id: `tool:${call.id}`,
          state: "running",
          text: call.name,
          tool: { name: call.name, input: call.input },
        });
      }
    } else if (message.role === "tool" && turn !== undefined) {
      turn = applyLegacyToolResult(turn, message);
    }
  }
  if (turn !== undefined) completed.push(turn);
  return { completed, nextId: completed.length + 1 };
}

export function transcriptFromLegacyConversation(
  messages: readonly TranscriptHistoryMessage[],
  compact?: TranscriptCompactBoundary,
): TranscriptState {
  return hydrateHistory(messages, compact);
}

function applyTaskSnapshot(turn: TranscriptTurn, snapshot: TaskSnapshot, includeTerminal = true): TranscriptTurn {
  const taskBlocks: Array<Extract<TranscriptBlock, { kind: "status" }>> = [];
  const previous = new Map(turn.blocks
    .filter((block): block is Extract<TranscriptBlock, { kind: "status" }> => block.kind === "status")
    .map((block) => [block.id, block]));
  const now = Date.now();
  const suppressed = new Set(turn.suppressedTaskIds ?? []);
  for (const task of snapshot.plan?.tasks ?? []) {
    const id = `task:${task.id}`;
    const terminal = ["completed", "failed", "blocked", "cancelled"].includes(task.status);
    if (!terminal) suppressed.delete(id);
    if ((!includeTerminal || suppressed.has(id)) && terminal) continue;
    const state = task.status === "in_progress" ? "running"
      : task.status === "completed" ? "completed"
      : task.status === "cancelled" ? "cancelled"
      : task.status === "failed" || task.status === "blocked" ? "failed"
      : "info";
    const suffix = task.status === "completed" ? "done" : task.status.replace("_", " ");
    const prior = previous.get(id);
    const startedAt = state === "running" ? prior?.startedAt ?? now : prior?.startedAt;
    const elapsedMs = state !== "running" && startedAt !== undefined
      ? prior?.elapsedMs ?? Math.max(0, now - startedAt)
      : prior?.elapsedMs;
    taskBlocks.push({
      kind: "status",
      id,
      state,
      text: `${state === "completed" ? "✓" : state === "failed" || state === "cancelled" ? "×" : "·"} ${task.subject} · ${suffix}`,
      task: { subject: task.subject, activeForm: task.activeForm, role: "main" },
      ...(startedAt === undefined ? {} : { startedAt }),
      ...(elapsedMs === undefined ? {} : { elapsedMs }),
    });
  }
  for (const node of snapshot.subagents.graph?.nodes ?? []) {
    const status = snapshot.subagents.states[node.id] ?? "pending";
    const id = `subagent:${node.id}`;
    const terminal = ["completed", "failed", "blocked", "cancelled"].includes(status);
    if (!terminal) suppressed.delete(id);
    if ((!includeTerminal || suppressed.has(id)) && terminal) continue;
    const state = status === "running" ? "running"
      : status === "completed" ? "completed"
      : status === "cancelled" ? "cancelled"
      : status === "failed" || status === "blocked" ? "failed"
      : "info";
    const prior = previous.get(id);
    const snapshotStartedAt = snapshot.subagents.startedAt?.[node.id];
    const snapshotElapsedMs = snapshot.subagents.elapsedMs?.[node.id];
    const startedAt = state === "running"
      ? snapshotStartedAt ?? prior?.startedAt ?? now
      : prior?.startedAt ?? snapshotStartedAt;
    const elapsedMs = state !== "running" && startedAt !== undefined
      ? prior?.elapsedMs ?? snapshotElapsedMs ?? Math.max(0, now - startedAt)
      : prior?.elapsedMs;
    taskBlocks.push({
      kind: "status",
      id,
      state,
      text: `${state === "completed" ? "✓" : state === "failed" || state === "cancelled" ? "×" : "·"} subagent: ${node.description} · ${status}`,
      task: { subject: node.description, activeForm: node.description, role: "subagent" },
      ...(startedAt === undefined ? {} : { startedAt }),
      ...(elapsedMs === undefined ? {} : { elapsedMs }),
    });
  }

  const ids = new Set(taskBlocks.map((block) => block.id));
  const blocks = turn.blocks.filter((block) => {
    if (block.kind !== "status") return true;
    if (!block.id.startsWith("task:") && !block.id.startsWith("subagent:")) return true;
    return ids.has(block.id);
  });
  for (const block of taskBlocks) {
    const index = blocks.findIndex((current) => current.kind === "status" && current.id === block.id);
    if (index < 0) blocks.push(block);
    else blocks[index] = block;
  }
  return {
    ...turn,
    taskSnapshot: snapshot,
    suppressedTaskIds: [...suppressed],
    blocks,
    statusLines: blocks.filter((block): block is Extract<TranscriptBlock, { kind: "status" }> => block.kind === "status")
      .map((block) => block.text),
  };
}

function terminalTaskIds(snapshot: TaskSnapshot): string[] {
  const ids = (snapshot.plan?.tasks ?? [])
    .filter((task) => ["completed", "failed", "blocked", "cancelled"].includes(task.status))
    .map((task) => `task:${task.id}`);
  for (const [id, status] of Object.entries(snapshot.subagents.states)) {
    if (["completed", "failed", "blocked", "cancelled"].includes(status)) ids.push(`subagent:${id}`);
  }
  return ids;
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
  const active = withoutModelActivity(state.active);
  return {
    completed: [...state.completed, active],
    nextId: state.nextId,
    ...(state.taskSnapshot === undefined ? {} : { taskSnapshot: state.taskSnapshot }),
  };
}

function withoutModelActivity(turn: TranscriptTurn, id?: string): TranscriptTurn {
  const blocks = turn.blocks.filter((block) => block.kind !== "status"
    || block.activity !== "model"
    || (id !== undefined && block.id !== id));
  if (blocks.length === turn.blocks.length) return turn;
  return {
    ...turn,
    blocks,
    statusLines: blocks
      .filter((block): block is Extract<TranscriptBlock, { kind: "status" }> => block.kind === "status")
      .map((block) => block.text),
  };
}

export function restoreTranscriptState(state: TranscriptState): TranscriptState {
  const completed = state.completed.map(cloneTurn);
  if (state.active !== undefined) completed.push(normalizeInterruptedTurn(cloneTurn(state.active)));
  return {
    completed,
    nextId: Math.max(state.nextId, ...completed.map((turn) => turn.id + 1), 1),
    ...(state.taskSnapshot === undefined ? {} : { taskSnapshot: state.taskSnapshot }),
  };
}

function compactionTurn(compact: TranscriptCompactBoundary): TranscriptTurn {
  const text = `Original execution steps before ${compact.compactedAt} are unavailable.`;
  return {
    id: 1,
    kind: "compaction",
    prompt: "Earlier execution history was compacted",
    assistantText: "",
    statusLines: [text],
    blocks: [{
      kind: "status",
      id: `compact-boundary:${compact.compactedAt}`,
      state: "info",
      tone: "warning",
      text,
      details: compact.summary,
    }],
  };
}

function applyLegacyToolResult(turn: TranscriptTurn, message: TranscriptHistoryMessage): TranscriptTurn {
  const id = message.toolCallId;
  const index = id === undefined ? -1 : turn.blocks.findIndex((block) => block.kind === "status" && block.id === `tool:${id}`);
  if (index < 0) {
    return upsertTurnStatus(turn, {
      kind: "status",
      id: `orphan-tool:${id ?? turn.blocks.length}`,
      state: "info",
      tone: "warning",
      text: "Orphaned historical tool result",
      details: message.content,
    });
  }
  const previous = turn.blocks[index]!;
  if (previous.kind !== "status" || previous.tool === undefined) return turn;
  const result = parseLegacyToolResult(message.content);
  const block: Extract<TranscriptBlock, { kind: "status" }> = {
    ...previous,
    state: result.ok ? "completed" : "failed",
    text: `${result.ok ? "✓" : "×"} ${previous.tool.name}`,
    tool: { ...previous.tool, result },
  };
  const blocks = [...turn.blocks];
  blocks[index] = block;
  return withBlocks(turn, blocks);
}

function parseLegacyToolResult(content: string): import("../tools/types.js").ToolResult {
  let value: unknown = content;
  try { value = JSON.parse(content); }
  catch { /* Older providers may have persisted plain-text tool output. */ }
  if (typeof value === "object" && value !== null && "error" in value) {
    const candidate = (value as { error?: unknown }).error;
    if (typeof candidate === "object" && candidate !== null) {
      const error = candidate as { code?: unknown; message?: unknown };
      return { ok: false, error: {
        code: typeof error.code === "string" ? error.code : "unknown",
        message: typeof error.message === "string" ? error.message : content,
      } };
    }
  }
  return { ok: true, output: value };
}

function normalizeInterruptedTurn(turn: TranscriptTurn): TranscriptTurn {
  const blocks = turn.blocks.flatMap((block): TranscriptBlock[] => {
    if (block.kind !== "status") return [block];
    if (block.activity === "model") return [];
    if (block.state !== "running") return [block];
    return [{ ...block, state: "cancelled", text: `× ${block.text.replace(/^[✓×·]\s*/, "")}` }];
  });
  return withBlocks(turn, blocks);
}

function cloneTurn(turn: TranscriptTurn): TranscriptTurn {
  return { ...turn, blocks: turn.blocks.map((block) => ({ ...block })), statusLines: [...turn.statusLines] };
}

function upsertTurnStatus(turn: TranscriptTurn, block: Extract<TranscriptBlock, { kind: "status" }>): TranscriptTurn {
  const blocks = [...turn.blocks];
  const index = blocks.findIndex((item) => item.kind === "status" && item.id === block.id);
  if (index < 0) blocks.push(block);
  else blocks[index] = block;
  return withBlocks(turn, blocks);
}

function withBlocks(turn: TranscriptTurn, blocks: TranscriptBlock[]): TranscriptTurn {
  return {
    ...turn,
    blocks,
    statusLines: blocks
      .filter((block): block is Extract<TranscriptBlock, { kind: "status" }> => block.kind === "status")
      .map((block) => block.text),
  };
}

function appendLine(text: string, line: string): string {
  return text.length === 0 || text.endsWith("\n") ? text + line : `${text}\n${line}`;
}

function stripRetryBlocks(turn: TranscriptTurn): TranscriptTurn {
  const blocks = turn.blocks.filter((block) => {
    if (block.kind !== "status") return true;
    if (block.id === "model-retry") return false;
    if (block.id.startsWith("structured-retry:")) return false;
    return true;
  });
  return {
    ...turn,
    blocks,
    statusLines: blocks
      .filter((item): item is Extract<TranscriptBlock, { kind: "status" }> => item.kind === "status")
      .map((item) => item.text),
  };
}

function addText(turn: TranscriptTurn, text: string, onNewLine = false): TranscriptTurn {
  const assistantText = onNewLine ? appendLine(turn.assistantText, text) : turn.assistantText + text;
  const blocks = [...turn.blocks];
  const last = blocks[blocks.length - 1];
  if (!onNewLine && last?.kind === "text") blocks[blocks.length - 1] = { kind: "text", text: last.text + text };
  else blocks.push({ kind: "text", text });
  return { ...turn, assistantText, blocks };
}
