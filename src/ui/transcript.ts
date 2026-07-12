import type { SessionOutput } from "./session.js";

export interface TranscriptTurn {
  id: number;
  prompt: string;
  assistantText: string;
  statusLines: string[];
  blocks: TranscriptBlock[];
}

export type TranscriptBlock = { kind: "text" | "status"; text: string };

export interface TranscriptState {
  completed: TranscriptTurn[];
  active?: TranscriptTurn;
  nextId: number;
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
  if (event.type === "exit" || state.active === undefined) return state;
  if (event.type === "done") {
    const withUsage = addStatus(state, `· ${event.usage.inputTokens} in · ${event.usage.outputTokens} out`);
    return finishActive(withUsage);
  }
  if (event.type === "text") {
    return { ...state, active: addText(state.active, event.text) };
  }
  if (event.type === "tool-start") return addStatus(state, `└ ${event.name} · running`);
  if (event.type === "tool-end") return addStatus(state, `${event.result.ok ? "✦" : "×"} ${event.name} · ${event.result.ok ? "done" : "failed"}`);
  if (event.type === "notice") return addStatus(state, `› ${event.message}`);
  if (event.type === "error") {
    return { ...state, active: addText(state.active, `◆ ${event.error.code}: ${event.error.message}`, true) };
  }
  if (event.type === "usage") return state;
  if (event.type === "compacted") return addStatus(state, "· Context compacted.");
  return state;
}

function addStatus(state: TranscriptState, line: string): TranscriptState {
  if (state.active === undefined) return state;
  return { ...state, active: {
    ...state.active,
    statusLines: [...state.active.statusLines, line],
    blocks: [...state.active.blocks, { kind: "status", text: line }],
  } };
}

function finishActive(state: TranscriptState): TranscriptState {
  if (state.active === undefined) return state;
  return { completed: [...state.completed, state.active], nextId: state.nextId };
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
