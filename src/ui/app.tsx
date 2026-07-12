import { basename } from "node:path";
import React, { useEffect, useReducer, useRef, useState } from "react";
import { Box, Static, Text, useApp, useInput, useStdout } from "ink";

import { createProductionRuntime, type ProductionRuntime } from "../production.js";
import { AssistantText } from "./assistant-text.js";
import type { SessionOutput } from "./session.js";
import { createSessionInterruptHandler, installSigintHandler } from "./signals.js";
import {
  createTranscriptState,
  transcriptReducer,
  type TranscriptTurn,
} from "./transcript.js";
import { wrapPromptInput } from "./wrap-prompt.js";
import { message } from "../utils/error.js";
import { redactErrorText } from "../utils/redact.js";

export const HISTORY_CAP = 200;

export interface FlavorAppProps { workspace: string; home?: string; resumeSession?: string | true }

export function App({ workspace, home, resumeSession }: FlavorAppProps): React.JSX.Element {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [runtime, setRuntime] = useState<ProductionRuntime>();
  const [input, setInput] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const [historyCursor, setHistoryCursor] = useState(0);
  const [promptCursor, setPromptCursor] = useState(0);
  const [revision, setRevision] = useState(0);
  const [columns, setColumns] = useState(stdout?.columns ?? 80);
  const [rows, setRows] = useState(stdout?.rows ?? 24);
  const [transcript, dispatch] = useReducer(transcriptReducer, undefined, createTranscriptState);
  const runtimeRef = useRef<ProductionRuntime | undefined>(undefined);
  const closing = useRef(false);

  const shutdown = async (active: ProductionRuntime | undefined) => {
    if (closing.current) return;
    closing.current = true;
    await shutdownRuntime(active, exit, (error) => {
      dispatch({ type: "submit-error", message: error });
    });
  };
  const shutdownRef = useRef(shutdown);
  shutdownRef.current = shutdown;
  const interruptRef = useRef<(() => void) | undefined>(undefined);
  interruptRef.current ??= createSessionInterruptHandler(
    () => runtimeRef.current?.session,
    () => shutdownRef.current(runtimeRef.current),
  );
  const interrupt = interruptRef.current;

  useEffect(() => {
    let disposed = false;
    const receive = (event: SessionOutput): void => {
      if (event.type === "exit") {
        void shutdownRef.current(runtimeRef.current);
        return;
      }
      dispatch(event.type === "clear" ? { type: "clear" } : { type: "session", event });
    };
    void createProductionRuntime({
      workspace,
      ...(home === undefined ? {} : { home }),
      ...(resumeSession === undefined ? {} : { resumeSession }),
      output: receive,
      onApprovalChange: () => setRevision((value) => value + 1),
    }).then(async (created) => {
      if (disposed) { await created.dispose(); return; }
      runtimeRef.current = created;
      setRuntime(created);
      await created.session.start();
    }).catch((error: unknown) => {
      dispatch({ type: "submit", prompt: "startup" });
      dispatch({ type: "submit-error", message: safeUiError(error) });
    });
    return () => {
      disposed = true;
      void closeAndDisposeRuntime(runtimeRef.current, (error) => process.stderr.write(`flavor cleanup: ${error}\n`));
    };
  }, [workspace, home, resumeSession]);

  useEffect(() => installSigintHandler(process, interrupt), [interrupt]);

  useEffect(() => {
    if (!stdout || typeof stdout.on !== "function") return;
    const onResize = (): void => {
      setColumns(stdout.columns ?? 80);
      setRows(stdout.rows ?? 24);
    };
    stdout.on("resize", onResize);
    onResize();
    return (): void => { stdout.off("resize", onResize); };
  }, [stdout]);

  useInput((character, key) => {
    const active = runtimeRef.current;
    if (key.ctrl && character === "c") { interrupt(); return; }
    if (active?.approvals.pending !== undefined) {
      if (character.toLowerCase() === "y") active.approvals.resolve(true);
      if (character.toLowerCase() === "n" || key.escape) active.approvals.resolve(false);
      return;
    }
    if (key.return) {
      const prompt = input.trim();
      if (!prompt || active === undefined || transcript.active !== undefined) return;
      dispatch({ type: "submit", prompt });
      setHistory((current) => [...current, prompt].slice(-HISTORY_CAP));
      setHistoryCursor(history.length + 1);
      setInput("");
      setPromptCursor(0);
      void submitSafely(active.session, prompt, (error) => {
        dispatch({ type: "submit-error", message: error });
      }).finally(() => dispatch({ type: "finish" }));
      return;
    }
    if (key.backspace) updatePrompt({ type: "backspace" }, input, promptCursor, setInput, setPromptCursor);
    else if (key.delete) updatePrompt({ type: "delete" }, input, promptCursor, setInput, setPromptCursor);
    else if (key.leftArrow) setPromptCursor((value) => Math.max(0, value - 1));
    else if (key.rightArrow) setPromptCursor((value) => Math.min([...input].length, value + 1));
    else if (key.pageUp || key.pageDown) return;
    else if (key.upArrow && history.length) {
      const next = navigateHistory({ history, cursor: historyCursor }, "up");
      setHistoryCursor(next.cursor); setInput(next.input); setPromptCursor(next.promptCursor);
    } else if (key.downArrow && history.length) {
      const next = navigateHistory({ history, cursor: historyCursor }, "down");
      setHistoryCursor(next.cursor); setInput(next.input); setPromptCursor(next.promptCursor);
    } else if (!key.ctrl && !key.meta && character) {
      updatePrompt({ type: "insert", value: character }, input, promptCursor, setInput, setPromptCursor);
    }
  });

  const approval = runtime?.approvals.pending;
  void revision;
  if (runtime === undefined) return <StartingLayout
    workspaceName={basename(workspace)}
    completed={transcript.completed}
    {...(transcript.active === undefined ? {} : { active: transcript.active })}
    columns={columns}
    rows={rows}
  />;
  return <TerminalLayout
    model={runtime.services.mainModel()}
    workspaceName={basename(workspace)}
    completed={transcript.completed}
    {...(transcript.active === undefined ? {} : { active: transcript.active })}
    input={input}
    promptCursor={promptCursor}
    columns={columns}
    rows={rows}
    activeSession={transcript.active !== undefined}
    {...(approval === undefined ? {} : { approval })}
  />;
}

function StartingLayout({
  workspaceName, completed, active, columns, rows,
}: Pick<TerminalLayoutProps, "workspaceName" | "completed" | "active" | "columns"> & { rows: number }): React.JSX.Element {
  return <TerminalLayout
    model="starting"
    workspaceName={workspaceName}
    completed={completed}
    {...(active === undefined ? {} : { active })}
    input=""
    promptCursor={0}
    columns={columns}
    rows={rows}
    activeSession={false}
  />;
}

export interface TerminalLayoutProps {
  model: string;
  workspaceName: string;
  completed: TranscriptTurn[];
  active?: TranscriptTurn;
  input: string;
  promptCursor: number;
  columns: number;
  rows?: number;
  activeSession: boolean;
  approval?: { tool: string; reason?: string };
}

export function TerminalLayout({
  model, workspaceName, completed, active, input, promptCursor, columns, rows = 24, activeSession, approval,
}: TerminalLayoutProps): React.JSX.Element {
  const dividerWidth = Math.max(1, columns - 1);
  const staticRows: StaticRow[] = [
    { kind: "header", model, workspaceName },
    ...completed.map((turn) => ({ kind: "turn" as const, turn })),
  ];
  return <>
    <Static items={staticRows}>{(row) => row.kind === "header"
      ? <Text key="header" dimColor>flavor · {row.model} · {row.workspaceName}</Text>
      : <TurnView key={row.turn.id} turn={row.turn} />}
    </Static>
    <Box flexDirection="column" minHeight={Math.max(4, rows - 1)}>
      {active === undefined ? null : <TurnView turn={active} />}
      <Box flexGrow={1} />
      {approval === undefined ? null : <Box flexDirection="column">
        <Text color="magenta">┌ approval · {approval.tool}</Text>
        <Text>{approval.reason ?? "This action needs permission."}</Text>
        <Text bold>Allow? y / n</Text>
      </Box>}
      <Text dimColor>{"─".repeat(dividerWidth)}</Text>
      <PromptLine input={input} cursor={promptCursor} columns={columns} />
      <Text dimColor>{activeSession ? "Ctrl+C cancel · Ctrl+C again exit" : "Enter send · ↑↓ history · Ctrl+C exit"}</Text>
    </Box>
  </>;
}

type StaticRow =
  | { kind: "header"; model: string; workspaceName: string }
  | { kind: "turn"; turn: TranscriptTurn };

function TurnView({ turn }: { turn: TranscriptTurn }): React.JSX.Element {
  return <Box flexDirection="column" marginBottom={1}>
    <Text><Text color="yellow" bold>❯ </Text>{turn.prompt}</Text>
    {turn.blocks.map((block, index) => block.kind === "status"
      ? <Text key={`${turn.id}-block-${index}`} dimColor>{block.text}</Text>
      : <AssistantText key={`${turn.id}-block-${index}`} text={block.text} />)}
  </Box>;
}

function PromptLine({ input, cursor, columns }: { input: string; cursor: number; columns: number }): React.JSX.Element {
  const wrap = wrapPromptInput(input, cursor, { columns, indent: 2 });
  return <Box width="100%" flexDirection="column">
    {wrap.lines.map((line, lineIndex) => {
      const isCursorLine = lineIndex === wrap.cursor.line;
      const points = [...line];
      const cursorCol = wrap.cursor.column;
      const before = points.slice(0, cursorCol).join("");
      const at = points[cursorCol] ?? "";
      const after = points.slice(cursorCol + 1).join("");
      return <Box key={lineIndex}>
        <Text color="yellow" bold>{lineIndex === 0 ? "❯ " : "  "}</Text>
        <Text>{before}{isCursorLine ? <Text inverse>{at || " "}</Text> : null}{after}</Text>
      </Box>;
    })}
  </Box>;
}

export interface PromptEditState { text: string; cursor: number }
export type PromptEdit = { type: "insert"; value: string } | { type: "backspace" | "delete" | "left" | "right" };
export function editPrompt(state: PromptEditState, edit: PromptEdit): PromptEditState {
  const points = [...state.text];
  const cursor = Math.max(0, Math.min(points.length, state.cursor));
  if (edit.type === "insert") {
    const inserted = [...edit.value]; points.splice(cursor, 0, ...inserted);
    return { text: points.join(""), cursor: cursor + inserted.length };
  }
  if (edit.type === "left") return { text: state.text, cursor: Math.max(0, cursor - 1) };
  if (edit.type === "right") return { text: state.text, cursor: Math.min(points.length, cursor + 1) };
  if (edit.type === "backspace") {
    if (cursor === 0) return { text: state.text, cursor };
    points.splice(cursor - 1, 1); return { text: points.join(""), cursor: cursor - 1 };
  }
  if (edit.type === "delete") { points.splice(cursor, 1); return { text: points.join(""), cursor }; }
  return { text: state.text, cursor };
}

export interface HistoryNavigationState { history: readonly string[]; cursor: number }
export interface HistoryNavigationResult { cursor: number; input: string; promptCursor: number }
export function navigateHistory(state: HistoryNavigationState, direction: "up" | "down"): HistoryNavigationResult {
  const cursor = direction === "up"
    ? Math.max(0, state.cursor - 1)
    : Math.min(state.history.length, state.cursor + 1);
  const input = state.history[cursor] ?? "";
  return { cursor, input, promptCursor: [...input].length };
}

function updatePrompt(
  edit: PromptEdit, text: string, cursor: number,
  setText: React.Dispatch<React.SetStateAction<string>>, setCursor: React.Dispatch<React.SetStateAction<number>>,
): void {
  const next = editPrompt({ text, cursor }, edit); setText(next.text); setCursor(next.cursor);
}



export async function submitSafely(
  session: Pick<ProductionRuntime["session"], "submit">, prompt: string, report: (message: string) => void,
): Promise<void> {
  try { await session.submit(prompt); }
  catch (error) { safeReport(report, safeUiError(error)); }
}

export async function shutdownRuntime(
  runtime: ProductionRuntime | undefined, exit: () => void, report: (message: string) => void,
): Promise<void> {
  try { await closeAndDisposeRuntime(runtime, report); }
  finally { exit(); }
}

export async function closeAndDisposeRuntime(
  runtime: ProductionRuntime | undefined, report: (message: string) => void,
): Promise<void> {
  if (runtime === undefined) return;
  try { await runtime.session.close(); }
  catch (error) { safeReport(report, safeUiError(error)); }
  finally {
    try { await runtime.dispose(); }
    catch (error) { safeReport(report, safeUiError(error)); }
  }
}

function safeUiError(error: unknown): string {
  return redactErrorText(message(error)).slice(0, 2_000);
}
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function safeReport(report: (message: string) => void, value: string): void {
  try { report(value); } catch { /* Cleanup and exit must not depend on diagnostics. */ }
}
