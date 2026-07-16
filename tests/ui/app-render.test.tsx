import React from "react";
import { renderToString } from "ink";
import { describe, expect, it } from "vitest";

import { TerminalLayout, statusLineColor } from "../../src/ui/app.js";
import {
  COMPACT_PROGRESS_COMPLETE,
  COMPACT_PROGRESS_REMAINING,
  compactProgressPresentation,
} from "../../src/ui/compact-progress.js";
import type { SlashCompletion } from "../../src/ui/slash-completion.js";
import { createTranscriptState, transcriptReducer, type TranscriptTurn } from "../../src/ui/transcript.js";

const turn = (id: number, prompt: string, assistantText: string): TranscriptTurn => ({
  id,
  prompt,
  assistantText,
  statusLines: [],
  blocks: assistantText.length === 0 ? [] : [{ kind: "text", text: assistantText }],
});

describe("TerminalLayout", () => {
  it("collapses pasted draft text but keeps submitted content fully visible with a spaced chevron", () => {
    const pasted = "first pasted line\nsecond pasted line\nthird pasted line";
    const output = renderToString(<TerminalLayout
      model="model"
      workspaceName="workspace"
      completed={[turn(1, pasted, "done")]}
      input={pasted}
      promptCursor={[...pasted].length}
      pastedBlocks={[{ id: 1, text: pasted }]}
      columns={80}
      activeSession={false}
    />, { columns: 80 }).replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");

    expect(output).toContain("[Pasted text #1 +2 lines]");
    expect(output.match(/first pasted line/g)).toHaveLength(1);
    expect(output).toContain("❯ first pasted line");
  });

  it("renders retry statuses in bright yellow", () => {
    const retrying: TranscriptTurn = {
      id: 1,
      prompt: "recover",
      assistantText: "",
      statusLines: ["↻ Retrying model call · attempt 2/5 in 1s"],
      blocks: [{
        kind: "status",
        id: "model-retry",
        state: "info",
        tone: "retry",
        text: "↻ Retrying model call · attempt 2/5 in 1s",
      }],
    };

    const raw = renderToString(<TerminalLayout
      model="model"
      workspaceName="workspace"
      completed={[retrying]}
      input=""
      promptCursor={0}
      columns={80}
      activeSession={false}
    />, { columns: 80 });

    expect(raw).toContain("↻ Retrying model call · attempt 2/5 in 1s");
    expect(statusLineColor(retrying.blocks[0] as Extract<TranscriptTurn["blocks"][number], { kind: "status" }>))
      .toBe("ansi:yellowBright");
  });

  it("renders compact progress as three blue and seven gray cells at thirty percent", () => {
    const compacting: TranscriptTurn = {
      id: 1,
      prompt: "/compact",
      assistantText: "",
      statusLines: ["Compacting context"],
      blocks: [{
        kind: "status",
        id: "compact:progress",
        state: "running",
        text: "Compacting context",
        progress: 30,
      }],
    };

    const raw = renderToString(<TerminalLayout
      model="model"
      workspaceName="workspace"
      completed={[]}
      active={compacting}
      input=""
      promptCursor={0}
      columns={80}
      activeSession
    />, { columns: 80 });
    const plain = raw.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
    expect(plain.match(/■/g)).toHaveLength(10);
    const presentation = compactProgressPresentation(30);
    expect(presentation.cells.filter((cell) => cell.color === COMPACT_PROGRESS_COMPLETE)).toHaveLength(3);
    expect(presentation.cells.filter((cell) => cell.color === COMPACT_PROGRESS_REMAINING)).toHaveLength(7);
    expect(plain).toContain("30%");
  });

  it("renders a completed update with numbered colored rows and white content", async () => {
    const changed: TranscriptTurn = {
      id: 1,
      prompt: "update notes",
      assistantText: "",
      statusLines: ["✓ Edit notes.md"],
      blocks: [{
        kind: "status",
        id: "tool:1",
        state: "completed",
        text: "✓ Edit notes.md",
        presentation: {
          kind: "file-change",
          operation: "update",
          path: "C:/workspace/notes.md",
          added: 1,
          removed: 1,
          lines: [
            { kind: "context", oldLine: 3, newLine: 3, text: "before" },
            { kind: "removed", oldLine: 4, text: "old" },
            { kind: "added", newLine: 4, text: "new" },
            { kind: "context", oldLine: 5, newLine: 5, text: "after" },
          ],
        },
      }],
    };

    const raw = renderToString(<TerminalLayout
      model="model"
      workspaceName="workspace"
      completed={[changed]}
      input=""
      promptCursor={0}
      columns={80}
      activeSession={false}
    />, { columns: 80 });
    const plain = raw.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");

    expect(plain).toContain("● Update(notes.md)");
    expect(plain).toContain("└ Added 1 line, removed 1 line");
    expect(plain).toContain("3  | before");
    expect(plain).toContain("4 -| old");
    expect(plain).toContain("4 +| new");
    expect(raw).toContain("\x1b[48;2;61;1;0m");
    expect(raw).toContain("\x1b[48;2;2;40;0m");
    const stylePath = "../../src/ui/file-diff-style.js";
    const styles = await import(stylePath).catch(() => ({})) as Record<string, unknown>;
    expect(typeof styles["fileDiffLineStyle"]).toBe("function");
    if (typeof styles["fileDiffLineStyle"] !== "function") return;
    const lineStyle = styles["fileDiffLineStyle"] as (kind: string) => Record<string, unknown>;
    expect(lineStyle("removed")).toEqual({
      backgroundColor: "#3d0100", markerColor: "#ff5f56", contentColor: "#f8f8f2",
    });
    expect(lineStyle("added")).toEqual({
      backgroundColor: "#022800", markerColor: "#50c878", contentColor: "#f8f8f2",
    });
  });

  it("labels a new file Create and renders its added rows", () => {
    const created: TranscriptTurn = {
      id: 1, prompt: "create", assistantText: "", statusLines: [],
      blocks: [{ kind: "status", id: "tool:1", state: "completed", text: "✓ Write new.txt", presentation: {
        kind: "file-change", operation: "create", path: "new.txt", added: 1, removed: 0,
        lines: [{ kind: "added", newLine: 1, text: "hello" }],
      } }],
    };
    const output = renderToString(<TerminalLayout
      model="model" workspaceName="workspace" completed={[created]} input="" promptCursor={0}
      columns={80} activeSession={false}
    />, { columns: 80 }).replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");

    expect(output).toContain("● Create(new.txt)");
    expect(output).toContain("└ Added 1 line, removed 0 lines");
    expect(output).toContain("1 +| hello");
  });

  it("renders deletion as only its operation and file name", () => {
    const deleted: TranscriptTurn = {
      id: 1, prompt: "delete", assistantText: "", statusLines: [],
      blocks: [{ kind: "status", id: "tool:1", state: "completed", text: "✓ Delete old.txt", presentation: {
        kind: "file-change", operation: "delete", path: "old.txt", added: 0, removed: 8, lines: [],
      } }],
    };
    const output = renderToString(<TerminalLayout
      model="model" workspaceName="workspace" completed={[deleted]} input="" promptCursor={0}
      columns={80} activeSession={false}
    />, { columns: 80 }).replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");

    expect(output).toContain("● Delete(old.txt)");
    expect(output).not.toContain("Added");
    expect(output).not.toContain("removed");
  });

  it("renders a selected slash candidate with highlighted matches and menu hints", () => {
    const completion: SlashCompletion = {
      query: "de",
      items: [
        { name: "deploy", kind: "command" },
        { name: "frontend-design", kind: "skill", description: "Design interfaces", source: "project" },
      ],
      selectedIndex: 1,
      windowStart: 0,
    };
    const raw = renderToString(<TerminalLayout
      model="model"
      workspaceName="workspace"
      completed={[]}
      input="/de"
      promptCursor={3}
      columns={80}
      activeSession={false}
      completion={completion}
    />, { columns: 80 });
    const output = raw.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");

    expect(output).toContain("deploy");
    expect(output).toContain("frontend-design");
    expect(output).toContain("Design interfaces");
    expect(output).not.toContain("  command");
    expect(output).not.toContain("  skill");
    expect(output).toContain("↑/↓ select · Tab complete · Esc close");
    expect(output).toContain("› frontend-design");
  });

  it("renders completed turns and the active SSE turn in append-only order above the prompt", () => {
    const output = renderToString(<TerminalLayout
      model="deepseek:v4"
      workspaceName="demo"
      completed={[turn(1, "first query", "first answer"), turn(2, "second query", "second answer")]}
      active={turn(3, "visible immediately", "streaming now")}
      input="next"
      promptCursor={4}
      columns={80}
      activeSession
    />, { columns: 80 }).replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");

    expect(output.indexOf("first query")).toBeLessThan(output.indexOf("first answer"));
    expect(output.indexOf("flavor · deepseek:v4 · demo")).toBeLessThan(output.indexOf("first query"));
    expect(output.indexOf("first answer")).toBeLessThan(output.indexOf("second query"));
    expect(output.indexOf("second answer")).toBeLessThan(output.indexOf("visible immediately"));
    expect(output.indexOf("streaming now")).toBeLessThan(output.indexOf("next"));
    expect(output).toContain("─".repeat(20));
  });

  it("renders hydrated conversation history without restored tool output", () => {
    const state = transcriptReducer(createTranscriptState(), { type: "hydrate", messages: [
      { role: "user", content: "restored question" },
      { role: "assistant", content: "restored answer" },
      { role: "tool", content: "hidden tool output" },
    ] });
    const output = renderToString(<TerminalLayout
      model="model"
      workspaceName="workspace"
      completed={state.completed}
      input=""
      promptCursor={0}
      columns={80}
      activeSession={false}
    />, { columns: 80 });

    expect(output).toContain("restored question");
    expect(output).toContain("restored answer");
    expect(output).not.toContain("hidden tool output");
  });

  it("does not emit application scroll-region or absolute-position escapes", () => {
    const output = renderToString(<TerminalLayout
      model="model"
      workspaceName="workspace"
      completed={[]}
      input=""
      promptCursor={0}
      columns={40}
      activeSession={false}
    />, { columns: 40 });

    expect(output).not.toMatch(/\x1B\[\d+;\d+r/);
    expect(output).not.toMatch(/\x1B\[\d+;\d+H/);
  });

  it("wraps prompt text within its padded inner width without a phantom row", () => {
    const output = renderToString(<TerminalLayout
      model="model"
      workspaceName="workspace"
      completed={[]}
      input="abcdefghijklmnopqr"
      promptCursor={18}
      columns={20}
      activeSession={false}
    />, { columns: 20 }).replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
    const lines = output.split("\n");
    const firstPromptLine = lines.findIndex((line) => line.includes("❯ abcdefghijklmnop"));

    expect(firstPromptLine).toBeGreaterThanOrEqual(0);
    expect(lines[firstPromptLine + 1]).toContain("  qr");
    expect(lines[firstPromptLine + 2]).toContain("Enter send");
  });

  it("animates only the foreground task while parallel subagents stay static", () => {
    const active: TranscriptTurn = {
      id: 1,
      prompt: "implement",
      assistantText: "",
      statusLines: [],
      blocks: [
        { kind: "status", id: "task:main", state: "running", text: "· Main · in progress",
          task: { subject: "Main", activeForm: "Implementing feature", role: "main" } },
        { kind: "status", id: "subagent:a", state: "running", text: "· Worker A · running",
          task: { subject: "Worker A", activeForm: "Worker A", role: "subagent" } },
        { kind: "status", id: "subagent:b", state: "running", text: "· Worker B · running",
          task: { subject: "Worker B", activeForm: "Worker B", role: "subagent" } },
      ],
    };
    const output = renderToString(<TerminalLayout
      model="model"
      workspaceName="workspace"
      completed={[]}
      active={active}
      input=""
      promptCursor={0}
      columns={80}
      activeSession
    />, { columns: 80 }).replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");

    expect(output).toContain("Implementing feature");
    expect(output).toContain("subagent: Worker A");
    expect(output).toContain("Worker B");
    expect(output.match(/⠋/gu)).toHaveLength(1);
  });

  it("renders the hint dimmed in parentheses next to the status text", () => {
    const turn: TranscriptTurn = {
      id: 1,
      prompt: "find",
      assistantText: "",
      statusLines: ["✓ Glob flavor-code"],
      blocks: [{
        kind: "status",
        id: "tool:1",
        state: "completed",
        text: "✓ Glob flavor-code",
        hint: "pattern: **/*.ts",
      }],
    };
    const raw = renderToString(<TerminalLayout
      model="model"
      workspaceName="workspace"
      completed={[turn]}
      input=""
      promptCursor={0}
      columns={120}
      activeSession={false}
    />, { columns: 120 });
    const plain = raw.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");

    expect(plain).toContain("✓ Glob flavor-code (pattern: **/*.ts)");
    // The raw output should differ from the plain output (i.e. ANSI is applied to style the hint differently).
    expect(raw).not.toBe(plain);
  });

  it("truncates a long hint with … without wrapping onto a new line", () => {
    const longHint = `pattern: ${"x".repeat(200)}`;
    const turn: TranscriptTurn = {
      id: 1,
      prompt: "find",
      assistantText: "",
      statusLines: ["✓ Glob"],
      blocks: [{
        kind: "status",
        id: "tool:1",
        state: "completed",
        text: "✓ Glob",
        hint: longHint,
      }],
    };
    const output = renderToString(<TerminalLayout
      model="model"
      workspaceName="workspace"
      completed={[turn]}
      input=""
      promptCursor={0}
      columns={40}
      activeSession={false}
    />, { columns: 40 });
    const plain = output.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");

    expect(plain).toContain("…");
    expect(plain).not.toContain("\n✓ Glob");
    // The full hint must not be present (truncation happened).
    expect(plain).not.toContain(longHint);
  });

  it("omits the hint segment entirely when block.hint is undefined", () => {
    const turn: TranscriptTurn = {
      id: 1,
      prompt: "find",
      assistantText: "",
      statusLines: ["✓ Read package.json"],
      blocks: [{
        kind: "status",
        id: "tool:1",
        state: "completed",
        text: "✓ Read package.json",
      }],
    };
    const plain = renderToString(<TerminalLayout
      model="model"
      workspaceName="workspace"
      completed={[turn]}
      input=""
      promptCursor={0}
      columns={120}
      activeSession={false}
    />, { columns: 120 }).replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");

    expect(plain).toContain("✓ Read package.json");
    expect(plain).not.toContain("(");
  });
});
