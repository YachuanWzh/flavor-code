import { basename } from "node:path";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useApp, useInput, useStdout } from "ink";

import { createProductionRuntime, type ProductionRuntime } from "../production.js";
import type { SessionOutput } from "./session.js";
import { createSessionInterruptHandler, installSigintHandler } from "./signals.js";
import { createRawStream, type RawStreamHandle } from "./raw-stream.js";
import { wrapPromptInput } from "./wrap-prompt.js";

/** Maximum number of past prompts retained in the up-arrow history. */
export const HISTORY_CAP = 200;

/** Rows reserved at the bottom for prompt + hint. */
const PROMPT_RESERVED_ROWS = 2;

/** Extra rows reserved while an approval request is on screen. */
const APPROVAL_RESERVED_ROWS = 3;

/** Hard floor for the streaming area so the prompt never crowds it out. */
const MIN_SCROLL_ROWS = 2;

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
  const [terminalRows, setTerminalRows] = useState(stdout?.rows ?? 24);
  const [terminalColumns, setTerminalColumns] = useState(stdout?.columns ?? 80);
  const closing = useRef(false);

  // Persisted conversation: completed user prompts and finalized assistant
  // responses. Raw ANSI content in the stream band is wiped on every Ink
  // re-render, so we move content here when streaming ends and render it as
  // React components (survives reconciliation).
  const [renderedMessages, setRenderedMessages] = useState<Array<{ role: "user" | "assistant"; text: string }>>([]);
  const wasActiveRef = useRef(false);

  // Compute the actual visual height of the wrapped prompt so the DECSTBM
  // scroll region and streaming band shrink/grow as the user types longer
  // inputs. Without this the prompt overflows its reserved rows when it
  // wraps to more lines than PROMPT_RESERVED_ROWS.
  const promptWrap = useMemo(
    () => wrapPromptInput(input, promptCursor, { columns: terminalColumns, indent: 2 }),
    [input, promptCursor, terminalColumns],
  );
  const promptHeight = promptWrap.height;

  // Base stream height (without approval adjustment) for RawStreamHandle
  // maxRows clamping. A 3-row difference during approval prompts is
  // imperceptible and doesn't justify recreating the stream handle.
  const baseStreamHeight = Math.max(MIN_SCROLL_ROWS, terminalRows - PROMPT_RESERVED_ROWS - (promptHeight - 1));

  // Cursor-bookkeeping handle for the streaming band. Recreated when
  // geometry changes so the `maxRows` clamp stays aligned with the
  // DECSTBM region set up in the useEffect below.
  const stream = useMemo<RawStreamHandle>(
    () => createRawStream({ stdout, topRow: 2, columns: terminalColumns, maxRows: baseStreamHeight }),
    [stdout, terminalColumns, baseStreamHeight],
  );

  // Apply DECSTBM whenever the geometry changes — this carves a slice
  // out of the screen between the header (row 1) and the prompt at the
  // bottom. Anything we write into that slice scrolls within it, so the
  // prompt never gets pushed around by streaming text.
  useEffect(() => {
    if (!stdout || typeof stdout.write !== "function") return;
    const reserved = PROMPT_RESERVED_ROWS + (promptHeight - 1) + (runtime?.approvals.pending !== undefined ? APPROVAL_RESERVED_ROWS : 0);
    const topRow = 2;
    const bottomRow = terminalRows - reserved;
    if (bottomRow <= topRow) return;
    try { stdout.write(`\x1B[${topRow};${bottomRow}r`); }
    catch { /* stdout may be closing */ }
    return (): void => {
      try { stdout.write(`\x1B[r`); } catch { /* ignore */ }
    };
  }, [stdout, terminalRows, promptHeight, runtime?.approvals.pending]);

  const shutdown = async (active: ProductionRuntime | undefined) => {
    if (closing.current) return;
    closing.current = true;
    await shutdownRuntime(active, exit, (error) => {
      stream.append(`◆ ${error}\n`);
    });
  };
  const receive = (event: SessionOutput) => {
    if (event.type === "clear") { stream.reset(); setRenderedMessages([]); return; }
    if (event.type === "exit") { void shutdown(runtimeRef.current); return; }
    if (event.type === "done") {
      // Append the usage line, then finalize and persist immediately so the
      // content is available to React in the same render pass as isActive → false.
      appendStreamEvent(stream, event);
      const finalized = stream.finalize();
      if (finalized) {
        // Replace the pending user prompt (added on Enter) with the complete
        // turn that includes both the user prompt and the assistant response.
        setRenderedMessages((prev) => {
          const base = prev.length > 0 && prev[prev.length - 1]!.role === "user"
            ? prev.slice(0, -1) : prev;
          return [...base, { role: "assistant" as const, text: finalized }];
        });
      }
      return;
    }
    appendStreamEvent(stream, event);
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
      workspace, ...(home === undefined ? {} : { home }),
      ...(resumeSession === undefined ? {} : { resumeSession }), output: receive,
      onApprovalChange: () => setRevision((value) => value + 1),
    }).then(async (created) => {
      if (disposed) { await created.dispose(); return; }
      runtimeRef.current = created; setRuntime(created); await created.session.start();
    }).catch((error: unknown) => stream.append(`◆ ${message(error)}\n`));
    return () => {
      disposed = true;
      void closeAndDisposeRuntime(runtimeRef.current, (error) => process.stderr.write(`flavor cleanup: ${error}\n`));
    };
    // Runtime lifetime is intentionally tied only to the workspace.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace, home, resumeSession]);

  useEffect(() => {
    return installSigintHandler(process, interrupt);
    // The handler reads the current runtime through a ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Track terminal dimensions so the prompt can be anchored to the actual
  // bottom of the screen instead of the bottom of the natural-height tree.
  useEffect(() => {
    if (!stdout || typeof stdout.on !== "function") return;
    const onResize = (): void => {
      setTerminalRows(stdout.rows ?? 24);
      setTerminalColumns(stdout.columns ?? 80);
    };
    stdout.on("resize", onResize);
    onResize();
    return (): void => { stdout.off("resize", onResize); };
  }, [stdout]);

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
      // Pre-fill the stream with the user prompt so it appears at the top
      // of the band and scrolls naturally as streaming text arrives below it.
      stream.start(`you › ${prompt}\n`);
      // Add as a pending user prompt — replaced by the complete turn
      // (user + assistant) when the stream finalizes.
      setRenderedMessages((prev) => [...prev, { role: "user" as const, text: prompt }]);
      setHistory((current) => [...current, prompt].slice(-HISTORY_CAP));
      setHistoryCursor(history.length + 1); setInput(""); setPromptCursor(0);
      void submitSafely(active.session, prompt, (error) => {
        setRenderedMessages((prev) => {
          const base = prev.length > 0 && prev[prev.length - 1]!.role === "user"
            ? prev.slice(0, -1) : prev;
          return [...base, { role: "assistant" as const, text: `you › ${prompt}\n◆ ${error}` }];
        });
      });
    } else if (key.backspace) updatePrompt({ type: "backspace" }, input, promptCursor, setInput, setPromptCursor);
    else if (key.delete) updatePrompt({ type: "delete" }, input, promptCursor, setInput, setPromptCursor);
    else if (key.leftArrow) setPromptCursor((value) => Math.max(0, value - 1));
    else if (key.rightArrow) setPromptCursor((value) => Math.min([...input].length, value + 1));
    // Ignore pageUp/pageDown — most terminals translate mouse scroll into
    // these sequences in alternate screen mode. History is ↑/↓ only.
    else if (key.pageUp || key.pageDown) { /* no-op: mouse scroll */ }
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

  // Detect streaming end: when session transitions from active to idle,
  // finalize the raw stream and persist the accumulated text as a React-
  // rendered message so it survives subsequent re-renders.
  // This is a fallback for cases where "done" was not received (cancel/error).
  const isActive = runtime?.session.active ?? false;
  useEffect(() => {
    if (wasActiveRef.current && !isActive) {
      const finalized = stream.finalize();
      if (finalized) {
        setRenderedMessages((prev) => {
          const base = prev.length > 0 && prev[prev.length - 1]!.role === "user"
            ? prev.slice(0, -1) : prev;
          return [...base, { role: "assistant" as const, text: finalized }];
        });
      }
    }
    wasActiveRef.current = isActive;
  }, [isActive, stream]);

  const reservedRows = PROMPT_RESERVED_ROWS + (promptHeight - 1) + (approval !== undefined ? APPROVAL_RESERVED_ROWS : 0);
  const streamHeight = Math.max(MIN_SCROLL_ROWS, terminalRows - reservedRows);

  // Compute visible lines from persisted messages for the stream band.
  // Only the last N lines that fit in the band are shown (older content
  // scrolls off the top).
  const bandLines = useMemo(() => {
    const all: Array<{ role: "user" | "assistant"; line: string }> = [];
    for (const msg of renderedMessages) {
      const rawLines = msg.text.split("\n");
      for (const raw of rawLines) {
        if (raw.length > 0) all.push({ role: msg.role, line: raw });
      }
    }
    // Trim to fit the band height.
    return all.length > streamHeight ? all.slice(all.length - streamHeight) : all;
  }, [renderedMessages, streamHeight]);

  return <Box flexDirection="column" height={terminalRows}>
    <Box flexShrink={0}>
      <Text dimColor>flavor · {runtime?.services.mainModel() ?? "starting"} · {basename(workspace)}</Text>
    </Box>
    {/* Stream band: when actively streaming, the box is empty and raw ANSI
        fills it via createRawStream. When idle, persisted messages are
        rendered as React components so they survive reconciliation. */}
    <Box flexShrink={1} flexGrow={1} height={streamHeight} flexDirection="column">
      {bandLines.map((item, idx) => (
        <Box key={idx}>
          {item.role === "user"
            ? <><Text color="yellow" bold>you › </Text><Text>{item.line}</Text></>
            : <Text>{item.line}</Text>}
        </Box>
      ))}
    </Box>
    {approval !== undefined && <Box flexShrink={0} flexDirection="column">
      <Text color="magenta">┆ approval · {approval.tool}</Text>
      <Text>{approval.reason ?? "This action needs permission."}</Text>
      <Text bold>Allow? y / n</Text>
    </Box>}
    <Box flexShrink={0} width="100%">
      <PromptLine input={input} cursor={promptCursor} columns={terminalColumns} />
    </Box>
    <Box flexShrink={0}>
      <Text dimColor>{runtime?.session.active ? "Ctrl+C cancel · Ctrl+C again exit" : "Enter send · ↑ history · Ctrl+C exit"}</Text>
    </Box>
  </Box>;
}

function PromptLine({ input, cursor, columns }: { input: string; cursor: number; columns: number }): React.JSX.Element {
  // We compute the wrap ourselves rather than relying on `<Text wrap="wrap">`.
  // The latter interacts poorly with incremental rendering — typed characters
  // can land in stray rows when the parent region re-paints, producing
  // duplicated prompt rows. Rendering each visual line as its own `<Text>`
  // gives Ink a stable tree shape and a stable cursor position.
  const wrap = wrapPromptInput(input, cursor, { columns, indent: 2 });
  return (
    <Box width="100%" flexDirection="column">
      {wrap.lines.map((line, lineIndex) => {
        const isCursorLine = lineIndex === wrap.cursor.line;
        const points = [...line];
        const cursorCol = wrap.cursor.column;
        const before = points.slice(0, cursorCol).join("");
        const at = points[cursorCol] ?? "";
        const after = points.slice(cursorCol + 1).join("");
        return (
          <Box key={lineIndex}>
            <Text color="yellow" bold>{lineIndex === 0 ? "› " : "  "}</Text>
            <Text>
              {before}
              {isCursorLine ? <Text inverse>{at || " "}</Text> : null}
              {after}
            </Text>
          </Box>
        );
      })}
    </Box>
  );
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
  if (edit.type === "delete") { points.splice(cursor, 1); return { text: state.text, cursor }; }
  return { text: state.text, cursor };
}

function updatePrompt(
  edit: PromptEdit, text: string, cursor: number,
  setText: React.Dispatch<React.SetStateAction<string>>, setCursor: React.Dispatch<React.SetStateAction<number>>,
): void {
  const next = editPrompt({ text, cursor }, edit); setText(next.text); setCursor(next.cursor);
}

/**
 * Map a session event to bytes written into the streaming band. The
 * mapping is deliberately tiny: this is a plain-text terminal view that
 * mirrors Claude Code's, so markdown decoration isn't emitted; tool /
 * status lines just get a one-character glyph.
 */
function appendStreamEvent(stream: RawStreamHandle, event: Exclude<SessionOutput, { type: "clear" | "exit" }>): void {
  switch (event.type) {
    case "text":
      stream.append(event.text);
      return;
    case "tool-start":
      stream.append(`┆ ${event.name} · running\n`);
      return;
    case "tool-end":
      stream.append(`${event.result.ok ? "◆" : "×"} ${event.name} · ${event.result.ok ? "done" : "failed"}\n`);
      return;
    case "notice":
      stream.append(`› ${event.message}\n`);
      return;
    case "error":
      stream.append(`◆ ${event.error.code}: ${event.error.message}\n`);
      return;
    case "usage":
      stream.append(`› ${event.totalInputTokens} in · ${event.totalOutputTokens} out\n`);
      return;
    case "done":
      stream.append(`› ${event.usage.inputTokens} in · ${event.usage.outputTokens} out\n`);
      return;
    case "compacted":
      stream.append(`› Context compacted.\n`);
      return;
  }
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
