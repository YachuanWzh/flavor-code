import { basename } from "node:path";
import React, { useEffect, useRef, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";

import { createProductionRuntime, type ProductionRuntime } from "../production.js";
import type { SessionOutput } from "./session.js";
import { createSessionInterruptHandler, installSigintHandler } from "./signals.js";

export interface FlavorAppProps { workspace: string; home?: string }

interface Line { id: number; kind: "user" | "assistant" | "tool" | "notice" | "error" | "usage"; text: string; done?: boolean }

export function App({ workspace, home }: FlavorAppProps): React.JSX.Element {
  const { exit } = useApp();
  const [runtime, setRuntime] = useState<ProductionRuntime>();
  const [lines, setLines] = useState<Line[]>([]);
  const [input, setInput] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const [historyCursor, setHistoryCursor] = useState(0);
  const [promptCursor, setPromptCursor] = useState(0);
  const [revision, setRevision] = useState(0);
  const nextId = useRef(0);
  const closing = useRef(false);

  const shutdown = async (active: ProductionRuntime | undefined) => {
    if (closing.current) return;
    closing.current = true;
    await shutdownRuntime(active, exit, (error) => {
      setLines((current) => [...current, { id: nextId.current++, kind: "error", text: error }]);
    });
  };
  const receive = (event: SessionOutput) => {
    if (event.type === "clear") { setLines([]); return; }
    if (event.type === "exit") { void shutdown(runtimeRef.current); return; }
    setLines((current) => reduceOutput(current, event, nextId));
  };
  const runtimeRef = useRef<ProductionRuntime | undefined>(undefined);
  const shutdownRef = useRef(shutdown); shutdownRef.current = shutdown;
  const interruptRef = useRef<(() => void) | undefined>(undefined);
  interruptRef.current ??= createSessionInterruptHandler(
    () => runtimeRef.current?.session,
    () => shutdownRef.current(runtimeRef.current),
  );
  const interrupt = interruptRef.current;

  useEffect(() => {
    let disposed = false;
    void createProductionRuntime({
      workspace, ...(home === undefined ? {} : { home }), output: receive,
      onApprovalChange: () => setRevision((value) => value + 1),
    }).then(async (created) => {
      if (disposed) { await created.dispose(); return; }
      runtimeRef.current = created; setRuntime(created); await created.session.start();
    }).catch((error: unknown) => setLines([{ id: nextId.current++, kind: "error", text: message(error) }]));
    return () => {
      disposed = true;
      void closeAndDisposeRuntime(runtimeRef.current, (error) => process.stderr.write(`flavor cleanup: ${error}\n`));
    };
    // Runtime lifetime is intentionally tied only to the workspace.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace, home]);

  useEffect(() => {
    return installSigintHandler(process, interrupt);
    // The handler reads the current runtime through a ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useInput((character, key) => {
    const active = runtimeRef.current;
    if (key.ctrl && character === "c") {
      interrupt();
      return;
    }
    if (active?.approvals.pending !== undefined) {
      if (character.toLowerCase() === "y") active.approvals.resolve(true);
      if (character.toLowerCase() === "n" || key.escape) active.approvals.resolve(false);
      return;
    }
    if (key.return) {
      const prompt = input.trim(); if (!prompt || active === undefined || active.session.active) return;
      setLines((current) => [...current, { id: nextId.current++, kind: "user", text: prompt }]);
      setHistory((current) => [...current, prompt]); setHistoryCursor(history.length + 1); setInput(""); setPromptCursor(0);
      void submitSafely(active.session, prompt, (error) => receive({
        type: "error", error: { code: "unknown", message: error },
      }));
    } else if (key.backspace) updatePrompt({ type: "backspace" }, input, promptCursor, setInput, setPromptCursor);
    else if (key.delete) updatePrompt({ type: "delete" }, input, promptCursor, setInput, setPromptCursor);
    else if (key.leftArrow) setPromptCursor((value) => Math.max(0, value - 1));
    else if (key.rightArrow) setPromptCursor((value) => Math.min([...input].length, value + 1));
    else if (key.upArrow && history.length) {
      const next = Math.max(0, historyCursor - 1); const value = history[next] ?? "";
      setHistoryCursor(next); setInput(value); setPromptCursor([...value].length);
    } else if (key.downArrow && history.length) {
      const next = Math.min(history.length, historyCursor + 1); const value = history[next] ?? "";
      setHistoryCursor(next); setInput(value); setPromptCursor([...value].length);
    } else if (!key.ctrl && !key.meta && character) {
      updatePrompt({ type: "insert", value: character }, input, promptCursor, setInput, setPromptCursor);
    }
  });

  const approval = runtime?.approvals.pending;
  void revision;
  return <Box flexDirection="column">
    <Text dimColor>flavor · {runtime?.services.mainModel() ?? "starting"} · {basename(workspace)}</Text>
    {lines.map((line) => <LineView key={line.id} line={line} />)}
    {approval !== undefined && <Box flexDirection="column">
      <Text color="magenta">┆ approval · {approval.tool}</Text>
      <Text>{approval.reason ?? "This action needs permission."}</Text>
      <Text bold>Allow? y / n</Text>
    </Box>}
    <PromptLine input={input} cursor={promptCursor} />
    <Text dimColor>{runtime?.session.active ? "Ctrl+C cancel · Ctrl+C again exit" : "Enter send · ↑ history · Ctrl+C exit"}</Text>
  </Box>;
}

function PromptLine({ input, cursor }: { input: string; cursor: number }): React.JSX.Element {
  const points = [...input];
  return <Box><Text color="yellow" bold>› </Text><Text>{points.slice(0, cursor).join("")}</Text>
    <Text inverse>{points[cursor] ?? " "}</Text><Text>{points.slice(cursor + 1).join("")}</Text></Box>;
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

function updatePrompt(
  edit: PromptEdit, text: string, cursor: number,
  setText: React.Dispatch<React.SetStateAction<string>>, setCursor: React.Dispatch<React.SetStateAction<number>>,
): void {
  const next = editPrompt({ text, cursor }, edit); setText(next.text); setCursor(next.cursor);
}

function LineView({ line }: { line: Line }): React.JSX.Element {
  if (line.kind === "tool") return <Text color={line.done ? "cyan" : "magenta"}>{line.done ? "◆" : "┆"} {line.text}</Text>;
  if (line.kind === "user") return <Text><Text color="yellow" bold>you › </Text>{line.text}</Text>;
  if (line.kind === "error") return <Text color="red">◆ {line.text}</Text>;
  if (line.kind === "usage") return <Text dimColor>{line.text}</Text>;
  if (line.kind === "notice") return <Text color="cyan">{line.text}</Text>;
  return <Text>{line.text}</Text>;
}

function reduceOutput(lines: Line[], event: Exclude<SessionOutput, { type: "clear" | "exit" }>, nextId: React.MutableRefObject<number>): Line[] {
  if (event.type === "text") {
    const last = lines.at(-1);
    if (last?.kind === "assistant") return [...lines.slice(0, -1), { ...last, text: last.text + event.text }];
    return [...lines, { id: nextId.current++, kind: "assistant", text: event.text }];
  }
  if (event.type === "tool-start") return [...lines, { id: nextId.current++, kind: "tool", text: `${event.name} · running` }];
  if (event.type === "tool-end") return [...lines, { id: nextId.current++, kind: "tool", text: `${event.name} · ${event.result.ok ? "done" : "failed"}`, done: true }];
  if (event.type === "notice") return [...lines, { id: nextId.current++, kind: "notice", text: event.message }];
  if (event.type === "error") return [...lines, { id: nextId.current++, kind: "error", text: `${event.error.code}: ${event.error.message}` }];
  if (event.type === "usage") return [...lines, { id: nextId.current++, kind: "usage", text: `${event.totalInputTokens} in · ${event.totalOutputTokens} out` }];
  if (event.type === "compacted") return [...lines, { id: nextId.current++, kind: "notice", text: "Context compacted." }];
  return lines;
}

function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }

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
  return message(error)
    .replace(/\bsk-[A-Za-z0-9_-]+\b/g, "[redacted]")
    .replace(/(authorization|api[_ -]?key|token)\s*[:=]\s*\S+/gi, "$1=[redacted]")
    .slice(0, 2_000);
}
function safeReport(report: (message: string) => void, value: string): void {
  try { report(value); } catch { /* Cleanup and exit must not depend on diagnostics. */ }
}
