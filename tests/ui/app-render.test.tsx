import React from "react";
import { renderToString } from "ink";
import { describe, expect, it } from "vitest";

import { TerminalLayout } from "../../src/ui/app.js";
import type { TranscriptTurn } from "../../src/ui/transcript.js";

const turn = (id: number, prompt: string, assistantText: string): TranscriptTurn => ({
  id,
  prompt,
  assistantText,
  statusLines: [],
  blocks: assistantText.length === 0 ? [] : [{ kind: "text", text: assistantText }],
});

describe("TerminalLayout", () => {
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
    expect(output).toContain("Worker A");
    expect(output).toContain("Worker B");
    expect(output.match(/⠋/gu)).toHaveLength(1);
  });
});
