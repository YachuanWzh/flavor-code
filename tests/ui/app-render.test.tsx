import React from "react";
import { renderToString } from "ink";
import { describe, expect, it } from "vitest";

import { ideFooterPresentation, MentionMenu, TerminalLayout, statusLineColor } from "../../src/ui/app.js";
import {
  COMPACT_PROGRESS_COMPLETE,
  COMPACT_PROGRESS_REMAINING,
  compactProgressPresentation,
} from "../../src/ui/compact-progress.js";
import type { SlashCompletion } from "../../src/ui/slash-completion.js";
import type { MentionCompletion } from "../../src/ui/mention-completion.js";
import { createTranscriptState, transcriptReducer, type TranscriptTurn } from "../../src/ui/transcript.js";
import { TaskProgressPanel, type TaskBlock } from "../../src/ui/task-progress.js";
import { WelcomeCard } from "../../src/ui/welcome.js";
import { packageVersion } from "../../src/utils/version.js";

const turn = (id: number, prompt: string, assistantText: string): TranscriptTurn => ({
  id,
  prompt,
  assistantText,
  statusLines: [],
  blocks: assistantText.length === 0 ? [] : [{ kind: "text", text: assistantText }],
});

const stripAnsi = (value: string): string => value.replace(/\x1B\[[0-?]*[ -/]*[@-~]/gu, "");

describe("TerminalLayout", () => {
  it("shows the active IDE file at the bottom right when there is no selection", () => {
    const output = stripAnsi(renderToString(<TerminalLayout
      model="model"
      workspaceName="workspace"
      completed={[]}
      input=""
      promptCursor={0}
      columns={90}
      rows={24}
      activeSession={false}
      ideContext={{
        ideName: "Visual Studio Code",
        workspaceFolders: ["/work"],
        filePath: "/work/flavor.json",
        selection: {
          start: { line: 3, character: 7 },
          end: { line: 3, character: 7 },
          active: { line: 3, character: 7 },
          isEmpty: true,
        },
      }}
    />, { columns: 90 }));

    expect(output).toContain("⧉ In flavor.json");
  });

  it("formats single-line and multi-line IDE selections like Claude Code", () => {
    const base = {
      ideName: "Visual Studio Code",
      workspaceFolders: ["/work"],
      filePath: "/work/src/main.ts",
    };
    expect(ideFooterPresentation({
      ...base,
      selectedText: "const one = 1;",
      selection: {
        start: { line: 4, character: 2 },
        end: { line: 4, character: 16 },
        active: { line: 4, character: 16 },
        isEmpty: false,
      },
    })).toBe("1 line selected");
    expect(ideFooterPresentation({
      ...base,
      selectedText: "five lines",
      selection: {
        start: { line: 4, character: 0 },
        end: { line: 9, character: 0 },
        active: { line: 9, character: 0 },
        isEmpty: false,
      },
    })).toBe("5 lines selected");
  });

  it("renders an implicit custom answer after agent-provided AskUser choices", () => {
    const output = stripAnsi(renderToString(<TerminalLayout
      model="model"
      workspaceName="workspace"
      completed={[]}
      input=""
      promptCursor={0}
      columns={90}
      rows={24}
      activeSession
      questions={[{
        header: "Approach",
        question: "Which approach should I use?",
        options: [{ label: "A", description: "Use approach A" }, { label: "B", description: "Use approach B" }],
      }]}
    />, { columns: 90 }));

    expect(output).toContain("1. A");
    expect(output).toContain("2. B");
    expect(output).toContain("3. Custom input");
  });

  it("renders the single pending CLI query directly above the prompt", () => {
    const output = stripAnsi(renderToString(<TerminalLayout
      model="model"
      workspaceName="workspace"
      completed={[]}
      input=""
      promptCursor={0}
      columns={90}
      rows={24}
      activeSession
      pendingPrompt="then add tests"
    />, { columns: 90 }));

    expect(output).toContain("Pending · then add tests");
    expect(output.indexOf("Pending · then add tests")).toBeLessThan(output.lastIndexOf("❯"));
    expect(output).toContain("Esc edit");
  });

  it("renders model-generated memory as pending confirmation instead of stored state", () => {
    const output = stripAnsi(renderToString(<TerminalLayout
      model="model"
      workspaceName="workspace"
      completed={[]}
      input=""
      promptCursor={0}
      columns={100}
      rows={24}
      activeSession={false}
      memoryReviews={[{ id: "memory-review-1", type: "project", content: "Use pnpm." }]}
    />, { columns: 100 }));

    expect(output).toContain("Long-term memory requires confirmation");
    expect(output).toContain("Use pnpm.");
    expect(output).toContain("Ctrl+Y");
    expect(output).toContain("Ctrl+N");
  });

  it("renders the Flavor brand mark with the sky-blue truecolor accent", () => {
    const wide = WelcomeCard({ model: "model", workspaceName: "workspace", columns: 96 });
    const wideLayout = wide.props.children as React.ReactElement<{ children?: React.ReactNode }>;
    const wideLeft = React.Children.toArray(wideLayout.props.children)[0] as React.ReactElement<{ children?: React.ReactNode }>;
    const wideWordmark = React.Children.toArray(wideLeft.props.children)[1] as React.ReactElement<{ color?: string }>;
    const compact = WelcomeCard({ model: "model", workspaceName: "workspace", columns: 48 });
    const compactLayout = compact.props.children as React.ReactElement<{ children?: React.ReactNode }>;
    const compactBrand = React.Children.toArray(compactLayout.props.children)[0] as React.ReactElement<{ color?: string }>;

    expect(wideWordmark.props.color).toBe("#67D4FF");
    expect(compactBrand.props.color).toBe("#67D4FF");
  });

  it("shows the Flavor welcome card only for an empty transcript", () => {
    const empty = stripAnsi(renderToString(<TerminalLayout
      model="anthropic:deepseek-v4-pro"
      workspaceName="flavor-code"
      completed={[]}
      input=""
      promptCursor={0}
      columns={96}
      rows={30}
      activeSession={false}
    />, { columns: 96 }));
    const active = stripAnsi(renderToString(<TerminalLayout
      model="anthropic:deepseek-v4-pro"
      workspaceName="flavor-code"
      completed={[]}
      active={turn(1, "hello", "")}
      input=""
      promptCursor={0}
      columns={96}
      rows={30}
      activeSession
    />, { columns: 96 }));

    expect(empty).toContain("Welcome back!");
    expect(empty).toContain("Tips for getting started");
    expect(empty).toContain("/init");
    expect(empty).toContain(`v${packageVersion()}`);
    expect(active).not.toContain("Welcome back!");
    expect(active).toContain("flavor · anthropic:deepseek-v4-pro · flavor-code");
  });

  it("uses a compact welcome card without overflowing narrow terminals", () => {
    const output = stripAnsi(renderToString(<TerminalLayout
      model="model"
      workspaceName="workspace"
      completed={[]}
      input=""
      promptCursor={0}
      columns={48}
      rows={20}
      activeSession={false}
    />, { columns: 48 }));

    expect(output).toContain("Flavor Code");
    expect(output).toContain(`v${packageVersion()}`);
    expect(output).not.toContain("Tips for getting started");
    expect(Math.max(...output.split("\n").map((line) => [...line].length))).toBeLessThanOrEqual(48);
  });

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

  it("renders numbered CLI image attachments above the prompt", () => {
    const output = stripAnsi(renderToString(<TerminalLayout
      model="openai:gpt-5"
      workspaceName="demo"
      completed={[]}
      input="inspect"
      imageAttachments={[
        { type: "image", source: { type: "file", path: "one.png" }, mediaType: "image/png", sha256: "a".repeat(64), bytes: 8, name: "wechat.png" },
        { type: "image", source: { type: "file", path: "two.png" }, mediaType: "image/png", sha256: "b".repeat(64), bytes: 8, name: "layout.png" },
      ]}
      promptCursor={7}
      columns={80}
      activeSession={false}
    />, { columns: 80 }));

    expect(output).toContain("[Image #1] wechat.png");
    expect(output).toContain("[Image #2] layout.png");
  });

  it("renders active model thinking beneath the submitted prompt", () => {
    const thinking: TranscriptTurn = {
      id: 1,
      prompt: "explain the system",
      assistantText: "",
      statusLines: ["Flavoring"],
      blocks: [{
        kind: "status",
        id: "model:1",
        state: "running",
        text: "Flavoring",
        activity: "model",
        startedAt: Date.now(),
      }],
    };

    const output = stripAnsi(renderToString(<TerminalLayout
      model="model"
      workspaceName="workspace"
      completed={[]}
      active={thinking}
      input=""
      promptCursor={0}
      columns={80}
      rows={24}
      activeSession
    />, { columns: 80 }));

    expect(output).toContain("explain the system");
    expect(output).toContain("Flavoring… (0s · thinking)");
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

  it("renders a selected at-file candidate with mouse and keyboard hints", () => {
    const mentionCompletion: MentionCompletion = {
      query: "app",
      items: ["src/app.test.ts", "src/ui/app.tsx"],
      selectedIndex: 1,
      windowStart: 0,
    };
    const raw = renderToString(<TerminalLayout
      model="model"
      workspaceName="workspace"
      completed={[]}
      input="@app"
      promptCursor={4}
      columns={80}
      activeSession={false}
      mentionCompletion={mentionCompletion}
    />, { columns: 80 });
    const output = raw.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");

    expect(output).toContain("src/app.test.ts");
    expect(output).toContain("› src/ui/app.tsx");
    expect(output).toContain("↑/↓ select · Tab complete · click choose · Esc close");
  });

  it("binds at-file rows to nonblank mouse clicks only", () => {
    const completion: MentionCompletion = {
      query: "app",
      items: ["src/app.tsx"],
      selectedIndex: 0,
      windowStart: 0,
    };
    const selected: string[] = [];
    const menu = MentionMenu({ completion, onSelect: (path) => selected.push(path) });
    const row = React.Children.toArray(menu.props.children)[0] as React.ReactElement<{
      onClick?: (event: { cellIsBlank: boolean }) => void;
    }>;

    row.props.onClick?.({ cellIsBlank: true });
    row.props.onClick?.({ cellIsBlank: false });
    expect(selected).toEqual(["src/app.tsx"]);
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

  it("renders restored CLI tools as compact summaries without raw JSON", () => {
    const state = transcriptReducer(createTranscriptState(), { type: "hydrate", messages: [
      { role: "user", content: "restored question" },
      { role: "assistant", content: "", toolCalls: [{ id: "read-1", name: "Read", input: { path: "notes.md" } }] },
      { role: "tool", toolCallId: "read-1", content: JSON.stringify("restored tool output") },
      { role: "assistant", content: "restored answer" },
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
    expect(output).toContain("✓ Read notes.md");
    expect(output).not.toContain("Input:");
    expect(output).not.toContain("Result:");
    expect(output).not.toContain("restored tool output");
  });

  it("summarizes shell outcomes without printing stdout and stderr bodies", () => {
    const turn: TranscriptTurn = {
      id: 1,
      prompt: "test",
      assistantText: "",
      statusLines: ["✓ Shell"],
      blocks: [{
        kind: "status", id: "tool:shell", state: "completed", text: "✓ Shell", hint: "npm test",
        tool: {
          name: "Shell",
          input: { command: "npm", args: ["test"] },
          result: { ok: true, output: { exitCode: 0, stdout: "very noisy output", stderr: "", truncated: false } },
        },
      }],
    };
    const output = renderToString(<TerminalLayout
      model="model" workspaceName="workspace" completed={[turn]} input="" promptCursor={0}
      columns={100} activeSession={false}
    />, { columns: 100 });

    expect(output).toContain("✓ Shell");
    expect(output).toContain("exit 0");
    expect(output).not.toContain("very noisy output");
  });

  it("renders a compacted legacy boundary separately from user prompts", () => {
    const state = transcriptReducer(createTranscriptState(), { type: "hydrate",
      compact: { summary: "Old work summary", compactedAt: "2026-07-20T10:00:00.000Z" },
      messages: [{ role: "user", content: "continue" }],
    });
    const output = renderToString(<TerminalLayout
      model="model" workspaceName="workspace" completed={state.completed} input="" promptCursor={0}
      columns={100} activeSession={false}
    />, { columns: 100 });

    expect(output).toContain("Earlier execution history was compacted");
    expect(output).toContain("Old work summary");
    expect(output).toContain("continue");
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
    expect(output).toContain("Enter queue");
    expect(output).toContain("Esc edit pending");
  });

  it("keeps every task available instead of slicing the list to six rows", () => {
    const active: TranscriptTurn = {
      id: 1,
      prompt: "implement",
      assistantText: "",
      statusLines: [],
      blocks: Array.from({ length: 8 }, (_, index) => ({
        kind: "status" as const,
        id: `subagent:worker-${index + 1}`,
        state: "info" as const,
        text: `· subagent: Worker ${index + 1} · pending`,
        task: { subject: `Worker ${index + 1}`, activeForm: `Worker ${index + 1}`, role: "subagent" as const },
      })),
    };
    const output = renderToString(<TerminalLayout
      model="model" workspaceName="workspace" completed={[]} active={active}
      input="next request" promptCursor={12} columns={80} rows={40} activeSession
    />, { columns: 80 }).replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");

    expect(output).toContain("Worker 7");
    expect(output).not.toContain("Worker 8");
    expect(output).not.toContain("... and 2 more");
    const panel = TaskProgressPanel({ blocks: active.blocks as TaskBlock[], interactive: true, maxHeight: 8 });
    const scroll = React.Children.toArray(panel?.props.children)[1] as React.ReactElement<{ children?: React.ReactNode }>;
    expect(React.Children.count(scroll.props.children)).toBe(8);
  });

  it("bounds wrapped task descriptions so the prompt stays inside a short viewport", () => {
    const active: TranscriptTurn = {
      id: 1,
      prompt: "implement",
      assistantText: "",
      statusLines: [],
      blocks: Array.from({ length: 6 }, (_, index) => ({
        kind: "status" as const,
        id: `subagent:long-${index + 1}`,
        state: "info" as const,
        text: `· subagent: ${"Long delegated task description ".repeat(3)}${index + 1} · pending`,
        task: {
          subject: `Long task ${index + 1}`,
          activeForm: `${"Long delegated task description ".repeat(3)}${index + 1}`,
          role: "subagent" as const,
        },
      })),
    };
    const output = renderToString(<TerminalLayout
      model="model" workspaceName="workspace" completed={[]} active={active}
      input="next request" promptCursor={12} columns={40} rows={12} activeSession
    />, { columns: 40 }).replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");

    expect(output).toContain("next request");
    expect(output).toContain("Ctrl+C cancel");
    expect(output.split("\n").length).toBeLessThanOrEqual(12);
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

  it("renders web search evidence as a ranked block separated from the final answer", () => {
    const items = Array.from({ length: 8 }, (_, index) => ({
      title: `DeepSeek result ${index + 1}`,
      url: `https://www.example${index + 1}.com/articles/result-${index + 1}?tracking=ignored`,
      snippet: `Snippet ${index + 1}`,
    }));
    const turn: TranscriptTurn = {
      id: 1,
      prompt: "deepseek 最新版本是多少？",
      assistantText: "结论正文",
      statusLines: [],
      blocks: [{
        kind: "status",
        id: "tool:web-search",
        state: "completed",
        text: "WebSearch",
        presentation: {
          kind: "web",
          title: "Search: DeepSeek 最新版本 模型 2026",
          summary: "8 results",
          items,
        },
      }, { kind: "text", text: "结论正文" }],
    };
    const raw = renderToString(<TerminalLayout
      model="model"
      workspaceName="workspace"
      completed={[turn]}
      input=""
      promptCursor={0}
      columns={100}
      activeSession={false}
    />, { columns: 100 });
    const plain = raw.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");

    expect(plain).toContain("┌─ WEB SEARCH · 8 RESULTS");
    expect(plain).toContain("│  DeepSeek 最新版本 模型 2026");
    expect(plain).toContain("│  01  DeepSeek result 1");
    expect(plain).toContain("│      example1.com/articles/result-1");
    expect(plain).toMatch(/└─ Showing 5 of 8\n\n\s+结论正文/u);
    expect(plain).not.toContain("DeepSeek result 6");
    expect(raw).not.toBe(plain);

    const narrow = renderToString(<TerminalLayout
      model="model"
      workspaceName="workspace"
      completed={[turn]}
      input=""
      promptCursor={0}
      columns={44}
      activeSession={false}
    />, { columns: 44 }).replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
    expect(narrow).toContain("WEB SEARCH · 8 RESULTS");
    expect(narrow).not.toContain("tracking=ignored");
    expect(narrow).not.toContain("DeepSeek result 6");
  });

  it("renders job state and logs as a bounded receipt separated from assistant text", () => {
    const turn: TranscriptTurn = {
      id: 1,
      prompt: "读取后台任务结果",
      assistantText: "后台任务失败，需要检查网络。",
      statusLines: [],
      blocks: [{
        kind: "status",
        id: "tool:job-read",
        state: "completed",
        text: "JobRead",
        presentation: {
          kind: "job",
          action: "read",
          id: "job-60eaefd1-0ea",
          jobKind: "shell",
          label: "check DeepSeek versions",
          state: "failed",
          exitCode: 1,
          cursor: 184,
          output: "=== [1/4] npm:deepseek ===\n0.0.2\n=== [2/4] pypi:deepseek ===\n1.0.0\nERR: fetch failed\n=== DONE ===\n",
        },
      }, { kind: "text", text: "后台任务失败，需要检查网络。" }],
    };
    const raw = renderToString(<TerminalLayout
      model="model" workspaceName="workspace" completed={[turn]}
      input="" promptCursor={0} columns={90} activeSession={false}
    />, { columns: 90 });
    const plain = raw.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");

    expect(plain).toContain("┌─ JOB · FAILED");
    expect(plain).toContain("│  job-60eaefd1-0ea · shell");
    expect(plain).toContain("│  check DeepSeek versions");
    expect(plain).toContain("├─ LOG · 6 LINES");
    expect(plain).toContain("│  ERR: fetch failed");
    expect(plain).toContain("└─ exit 1 · cursor 184");
    expect(plain).toMatch(/cursor 184\n\n\s+后台任务失败/u);
    expect(raw).not.toBe(plain);
  });

  it("renders wait receipts without a log section and bounds job lists", () => {
    const jobs = Array.from({ length: 10 }, (_, index) => ({
      id: `job-00000000-00${index}`,
      kind: "shell",
      label: `background command ${index}`,
      state: index === 0 ? "failed" as const : "completed" as const,
      exitCode: index === 0 ? 1 : 0,
    }));
    const turn: TranscriptTurn = {
      id: 1, prompt: "检查任务", assistantText: "检查完成。", statusLines: [],
      blocks: [{
        kind: "status", id: "tool:wait", state: "completed", text: "JobWait",
        presentation: {
          kind: "job", action: "wait", id: jobs[0]!.id, jobKind: "shell",
          label: jobs[0]!.label, state: "failed", exitCode: 1,
        },
      }, {
        kind: "status", id: "tool:list", state: "completed", text: "JobList",
        presentation: { kind: "job", action: "list", jobs },
      }, { kind: "text", text: "检查完成。" }],
    };
    const plain = renderToString(<TerminalLayout
      model="model" workspaceName="workspace" completed={[turn]}
      input="" promptCursor={0} columns={90} rows={40} activeSession={false}
    />, { columns: 90 }).replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");

    expect(plain).toContain("JOB · FAILED");
    expect(plain).toContain("└─ exit 1");
    expect(plain).not.toContain("LOG · NO NEW OUTPUT");
    expect(plain).toContain("JOBS · 10");
    expect(plain).toContain("└─ Showing 8 of 10");
    expect(plain).not.toContain("background command 8");
  });

  it("renders successful command output as a bounded receipt separated from assistant text", () => {
    const outputLines = Array.from({ length: 20 }, (_, index) => `file-${index + 1}.ts | ${index + 1} +++`).join("\n");
    const turn: TranscriptTurn = {
      id: 1, prompt: "查看提交", assistantText: "这个提交修改了多个文件。", statusLines: [],
      blocks: [{
        kind: "status", id: "tool:shell", state: "completed", text: "Shell",
        presentation: {
          kind: "terminal", title: "git show", command: "git show --stat --oneline 14adcc5",
          stdout: `14adcc5 feat(desktop): improve E2E\n${outputLines}\n`, stderr: "", exitCode: 0,
          state: "completed",
        },
      }, { kind: "text", text: "这个提交修改了多个文件。" }],
    };
    const raw = renderToString(<TerminalLayout
      model="model" workspaceName="workspace" completed={[turn]}
      input="" promptCursor={0} columns={88} rows={50} activeSession={false}
    />, { columns: 88 });
    const plain = raw.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");

    expect(plain).toContain("┌─ COMMAND · COMPLETED");
    expect(plain).toContain("│  git show --stat --oneline 14adcc5");
    expect(plain).toContain("├─ OUTPUT · 21 LINES");
    expect(plain).toContain("│  14adcc5 feat(desktop): improve E2E");
    expect(plain).toContain("│  … 5 lines hidden");
    expect(plain).toContain("└─ exit 0");
    expect(plain).toMatch(/exit 0\n\n\s+这个提交修改了多个文件/u);
    expect(raw).not.toBe(plain);
  });

  it("renders failed command stderr with error hierarchy and stays compact on narrow terminals", () => {
    const turn: TranscriptTurn = {
      id: 1, prompt: "查看状态", assistantText: "命令参数需要调整。", statusLines: [],
      blocks: [{
        kind: "status", id: "tool:shell", state: "completed", text: "Shell",
        presentation: {
          kind: "terminal", title: "git status", command: "git status --short",
          stdout: "", stderr: "'git status' 不是内部或外部命令，也不是可运行的程序。\n", exitCode: 1,
          state: "failed",
        },
      }, { kind: "text", text: "命令参数需要调整。" }],
    };
    const raw = renderToString(<TerminalLayout
      model="model" workspaceName="workspace" completed={[turn]}
      input="" promptCursor={0} columns={46} rows={32} activeSession={false}
    />, { columns: 46 });
    const plain = raw.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");

    expect(plain).toContain("COMMAND · FAILED");
    expect(plain).toContain("git status --short");
    expect(plain).toContain("ERROR · 1 LINE");
    expect(plain).toContain("exit 1");
    expect(plain).toMatch(/exit 1\n\n\s+命令参数需要调整/u);
    expect(raw).not.toBe(plain);
  });

  it("shares the 16-line command receipt budget between stdout and stderr", () => {
    const stream = (prefix: string) => Array.from({ length: 12 }, (_, index) => `${prefix} ${index + 1}`).join("\n");
    const turn: TranscriptTurn = {
      id: 1, prompt: "run", assistantText: "done", statusLines: [],
      blocks: [{
        kind: "status", id: "tool:mixed", state: "completed", text: "Shell",
        presentation: {
          kind: "terminal", variant: "command", title: "mixed", command: "mixed",
          stdout: stream("out"), stderr: stream("err"), exitCode: 1, state: "failed",
        },
      }],
    };
    const plain = renderToString(<TerminalLayout
      model="model" workspaceName="workspace" completed={[turn]}
      input="" promptCursor={0} columns={80} rows={40} activeSession={false}
    />, { columns: 80 }).replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");

    expect(plain).toContain("OUTPUT · 12 LINES");
    expect(plain).toContain("ERROR · 12 LINES");
    expect(plain.match(/… 4 lines hidden/gu)).toHaveLength(2);
    expect(plain).toContain("out 1");
    expect(plain).toContain("out 12");
    expect(plain).toContain("err 1");
    expect(plain).toContain("err 12");
  });

  it("renders turn deliverables as a workspace-relative changeset receipt", () => {
    const turn: TranscriptTurn = {
      id: 1, prompt: "更新变更日志", assistantText: "变更日志已经更新。", statusLines: [],
      blocks: [{
        kind: "status", id: "deliverables:1", state: "completed", text: "Changed 3 files",
        details: "legacy fallback must not be rendered twice",
        presentation: {
          kind: "changeset",
          files: [
            { path: "C:\\Users\\wangzh\\Desktop\\idea\\flavor-code\\CHANGELOG.md", operation: "update", added: 26, removed: 1 },
            { path: "C:\\Users\\wangzh\\Desktop\\idea\\flavor-code\\src\\new.ts", operation: "create", added: 12, removed: 0 },
            { path: "C:\\Users\\wangzh\\Desktop\\idea\\flavor-code\\src\\old.ts", operation: "delete", added: 0, removed: 4 },
          ],
        },
      }, { kind: "text", text: "变更日志已经更新。" }],
    };
    const raw = renderToString(<TerminalLayout
      model="model" workspaceName="flavor-code" completed={[turn]}
      input="" promptCursor={0} columns={88} rows={32} activeSession={false}
    />, { columns: 88 });
    const plain = raw.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");

    expect(plain).toContain("┌─ CHANGESET · 3 FILES");
    expect(plain).toContain("│  UPDATE  +26 -1   CHANGELOG.md");
    expect(plain).toContain("│  CREATE  +12 -0   src/new.ts");
    expect(plain).toContain("│  DELETE  +0 -4    src/old.ts");
    expect(plain).toContain("└─ +38 -5");
    expect(plain).not.toContain("C:\\Users\\wangzh");
    expect(plain).not.toContain("legacy fallback");
    expect(plain).toMatch(/\+38 -5\n\n\s+变更日志已经更新/u);
    expect(raw).not.toBe(plain);
  });

  it("bounds long changeset receipts and reports omitted files", () => {
    const files = Array.from({ length: 10 }, (_, index) => ({
      path: `C:\\work\\flavor-code\\src\\file-${index + 1}.ts`,
      operation: "update" as const,
      added: index + 1,
      removed: 0,
    }));
    const turn: TranscriptTurn = {
      id: 1, prompt: "批量更新", assistantText: "", statusLines: [],
      blocks: [{
        kind: "status", id: "deliverables:1", state: "completed", text: "Changed 10 files",
        presentation: { kind: "changeset", files },
      }],
    };
    const plain = renderToString(<TerminalLayout
      model="model" workspaceName="flavor-code" completed={[turn]}
      input="" promptCursor={0} columns={60} rows={32} activeSession={false}
    />, { columns: 60 }).replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");

    expect(plain).toContain("CHANGESET · 10 FILES");
    expect(plain).toContain("src/file-8.ts");
    expect(plain).not.toContain("src/file-9.ts");
    expect(plain).toContain("└─ +55 -0 · Showing 8 of 10");
  });
});
