import React from "react";
import { renderToString } from "ink";
import { describe, expect, it } from "vitest";

import { TerminalLayout } from "../../src/ui/app.js";
import type { SlashCompletion } from "../../src/ui/slash-completion.js";
import type { TranscriptTurn } from "../../src/ui/transcript.js";

const turn = (id: number, prompt: string, assistantText: string): TranscriptTurn => ({
  id,
  prompt,
  assistantText,
  statusLines: [],
  blocks: assistantText.length === 0 ? [] : [{ kind: "text", text: assistantText }],
});

describe("TerminalLayout", () => {
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
    expect(output).toContain("Worker A / subagent");
    expect(output).toContain("Worker B");
    expect(output.match(/⠋/gu)).toHaveLength(1);
  });
});
