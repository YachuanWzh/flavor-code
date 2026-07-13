import { describe, expect, it } from "vitest";

import {
  DEFAULT_COMPACTION_POLICY,
  OLD_TOOL_RESULT_CLEARED,
  buildCompactPrompt,
  calculateContextPressure,
  compactContinuationMessage,
  formatCompactSummary,
  groupMessagesByApiRound,
  microcompactMessages,
  selectRecentStart,
  type CompactionPolicy,
} from "../../src/context/compaction.js";
import type { ModelMessage } from "../../src/models/types.js";

describe("context pressure", () => {
  it("matches Claude Code's effective-window auto-compact threshold", () => {
    const below = calculateContextPressure(166_999, DEFAULT_COMPACTION_POLICY);
    const at = calculateContextPressure(167_000, DEFAULT_COMPACTION_POLICY);

    expect(at.effectiveWindowTokens).toBe(180_000);
    expect(at.autoCompactThresholdTokens).toBe(167_000);
    expect(below.shouldAutoCompact).toBe(false);
    expect(at.shouldAutoCompact).toBe(true);
    expect(calculateContextPressure(177_000, DEFAULT_COMPACTION_POLICY).isAtBlockingLimit).toBe(true);
  });
});

describe("API-round grouping and recent retention", () => {
  const messages: ModelMessage[] = [
    { role: "user", content: "inspect" },
    { role: "assistant", content: "", toolCalls: [{ id: "read-1", name: "Read", input: { path: "a" } }] },
    { role: "tool", content: "file", toolCallId: "read-1" },
    { role: "assistant", content: "inspection complete" },
    { role: "user", content: "change it" },
    { role: "assistant", content: "done" },
  ];

  it("keeps a tool call and its result in the same API round", () => {
    expect(groupMessagesByApiRound(messages).map((group) => group.map((message) => message.role))).toEqual([
      ["user"],
      ["assistant", "tool"],
      ["assistant", "user"],
      ["assistant"],
    ]);
  });

  it("selects recent content only at a safe round boundary", () => {
    const policy: CompactionPolicy = {
      ...DEFAULT_COMPACTION_POLICY,
      recentTokens: 1,
      recentTextMessages: 2,
      maxRecentTokens: 100,
    };

    const start = selectRecentStart(messages, policy);

    expect(start).toBe(4);
    expect(messages.slice(start).map((message) => message.content)).toEqual(["change it", "done"]);
  });
});

describe("microcompaction", () => {
  it("clears only old compactable tool results and keeps the newest N", () => {
    const messages: ModelMessage[] = [
      { role: "assistant", content: "", toolCalls: [{ id: "read-old", name: "Read", input: {} }] },
      { role: "tool", content: "old read output", toolCallId: "read-old" },
      { role: "assistant", content: "", toolCalls: [{ id: "todo", name: "TodoWrite", input: {} }] },
      { role: "tool", content: "task state", toolCallId: "todo" },
      { role: "assistant", content: "", toolCalls: [{ id: "shell-new", name: "Shell", input: {} }] },
      { role: "tool", content: "new shell output", toolCallId: "shell-new" },
    ];

    const result = microcompactMessages(messages, 1);

    expect(result.changed).toBe(true);
    expect(result.clearedResults).toBe(1);
    expect(result.messages[1]?.content).toBe(OLD_TOOL_RESULT_CLEARED);
    expect(result.messages[3]?.content).toBe("task state");
    expect(result.messages[5]?.content).toBe("new shell output");
    expect(messages[1]?.content).toBe("old read output");
  });
});

describe("compact summaries", () => {
  it("uses the Claude-style no-tools preamble and nine continuation sections", () => {
    const prompt = buildCompactPrompt();

    expect(prompt).toContain("Respond with TEXT ONLY");
    expect(prompt).toContain("Do NOT call any tools");
    expect(prompt).toContain("1. Primary Request and Intent");
    expect(prompt).toContain("9. Optional Next Step");
    expect(prompt).toContain("quote the most recent user request");
  });

  it("strips analysis scratch work and extracts the summary body", () => {
    expect(formatCompactSummary("<analysis>draft only</analysis>\n<summary>\nkept result\n</summary>")).toBe("kept result");
  });

  it("accepts non-empty untagged compatibility output and rejects empty output", () => {
    expect(formatCompactSummary(" legacy summary ")).toBe("legacy summary");
    expect(() => formatCompactSummary("  \n ")).toThrow(/empty/i);
  });

  it("wraps the summary as a direct continuation message", () => {
    const message = compactContinuationMessage("work state", "C:/tmp/transcript.jsonl");

    expect(message).toContain("continued from a previous conversation");
    expect(message).toContain("work state");
    expect(message).toContain("C:/tmp/transcript.jsonl");
    expect(message).toContain("Resume directly");
  });
});
