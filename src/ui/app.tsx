import { basename } from "node:path";
import React, { useEffect, useRef, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";

import { createProductionRuntime, type ProductionRuntime } from "../production.js";
import type { SessionOutput } from "./session.js";

export interface FlavorAppProps { workspace: string; home?: string }

interface Line { id: number; kind: "user" | "assistant" | "tool" | "notice" | "error" | "usage"; text: string; done?: boolean }

export function App({ workspace, home }: FlavorAppProps): React.JSX.Element {
  const { exit } = useApp();
  const [runtime, setRuntime] = useState<ProductionRuntime>();
  const [lines, setLines] = useState<Line[]>([]);
  const [input, setInput] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const [cursor, setCursor] = useState(0);
  const [revision, setRevision] = useState(0);
  const nextId = useRef(0);
  const closing = useRef(false);

  const shutdown = async (active: ProductionRuntime | undefined) => {
    if (closing.current) return;
    closing.current = true;
    await active?.session.close();
    await active?.dispose();
    exit();
  };
  const receive = (event: SessionOutput) => {
    if (event.type === "clear") { setLines([]); return; }
    if (event.type === "exit") { void shutdown(runtimeRef.current); return; }
    setLines((current) => reduceOutput(current, event, nextId));
  };
  const runtimeRef = useRef<ProductionRuntime | undefined>(undefined);

  useEffect(() => {
    let disposed = false;
    void createProductionRuntime({
      workspace, ...(home === undefined ? {} : { home }), output: receive,
      onApprovalChange: () => setRevision((value) => value + 1),
    }).then(async (created) => {
      if (disposed) { await created.dispose(); return; }
      runtimeRef.current = created; setRuntime(created); await created.session.start();
    }).catch((error: unknown) => setLines([{ id: nextId.current++, kind: "error", text: message(error) }]));
    return () => { disposed = true; void runtimeRef.current?.session.close().then(() => runtimeRef.current?.dispose()); };
    // Runtime lifetime is intentionally tied only to the workspace.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace, home]);

  useInput((character, key) => {
    const active = runtimeRef.current;
    if (key.ctrl && character === "c") {
      if (active?.session.interrupt() === "exit") void shutdown(active);
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
      setHistory((current) => [...current, prompt]); setCursor(history.length + 1); setInput("");
      void active.session.submit(prompt);
    } else if (key.backspace || key.delete) setInput((value) => value.slice(0, -1));
    else if (key.upArrow && history.length) {
      const next = Math.max(0, cursor - 1); setCursor(next); setInput(history[next] ?? "");
    } else if (key.downArrow && history.length) {
      const next = Math.min(history.length, cursor + 1); setCursor(next); setInput(history[next] ?? "");
    } else if (!key.ctrl && !key.meta && character) setInput((value) => value + character);
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
    <Box><Text color="yellow" bold>› </Text><Text>{input}</Text><Text inverse> </Text></Box>
    <Text dimColor>{runtime?.session.active ? "Ctrl+C cancel · Ctrl+C again exit" : "Enter send · ↑ history · Ctrl+C exit"}</Text>
  </Box>;
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
