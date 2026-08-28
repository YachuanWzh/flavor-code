import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  attachmentTranscriptPrompt,
  coalesceDesktopEvents,
  desktopThinkingPreview,
  DesktopImageAttachmentStrip,
  DesktopTurnView,
} from "../../src/desktop/renderer/app.js";
import type { TranscriptTurn } from "../../src/ui/transcript.js";

describe("desktop restored timeline rendering", () => {
  it("coalesces adjacent stream deltas without crossing an ordering boundary", () => {
    const events = coalesceDesktopEvents([
      { type: "session-output", sessionId: "one", event: { type: "text", text: "a" } },
      { type: "session-output", sessionId: "one", event: { type: "text", text: "b" } },
      { type: "session-output", sessionId: "one", event: { type: "model-end", id: "m" } },
      { type: "session-output", sessionId: "one", event: { type: "text", text: "c" } },
      { type: "session-output", sessionId: "two", event: { type: "text", text: "d" } },
    ]);

    expect(events).toHaveLength(4);
    expect(events[0]).toMatchObject({ sessionId: "one", event: { type: "text", text: "ab" } });
    expect(events[1]).toMatchObject({ event: { type: "model-end" } });
    expect(events[2]).toMatchObject({ sessionId: "one", event: { type: "text", text: "c" } });
    expect(events[3]).toMatchObject({ sessionId: "two", event: { type: "text", text: "d" } });
  });

  it("renders Claude-style numbered image chips and transcript references", () => {
    const attachments = [
      {
        id: "one", name: "screen.png", mediaType: "image/png" as const,
        dataBase64: "abc", previewUrl: "blob:one",
      },
      {
        id: "two", name: "layout.webp", mediaType: "image/webp" as const,
        dataBase64: "def", previewUrl: "blob:two",
      },
    ];

    const html = renderToStaticMarkup(
      <DesktopImageAttachmentStrip attachments={attachments} onRemove={() => undefined} />,
    );

    expect(html).toContain("[Image #1]");
    expect(html).toContain("[Image #2]");
    expect(html).toContain("screen.png");
    expect(html).toContain("layout.webp");
    expect(attachmentTranscriptPrompt("Inspect", attachments)).toBe(
      "Inspect\n[Image #1]\n[Image #2]",
    );
  });

  it("shows task-plan cards only while their owning turn is active", () => {
    const turn: TranscriptTurn = {
      id: 1,
      prompt: "implement",
      assistantText: "done",
      statusLines: ["Build feature · in progress"],
      blocks: [{
        kind: "status",
        id: "task:build",
        state: "running",
        text: "Build feature · in progress",
        task: { subject: "Build feature", activeForm: "Building feature", role: "main" },
      }],
    };

    expect(renderToStaticMarkup(<DesktopTurnView turn={turn} active />)).toContain("Build feature");
    expect(renderToStaticMarkup(<DesktopTurnView turn={turn} />)).not.toContain("Build feature");
  });

  it("renders streamed model reasoning as a quiet timeline continuation", () => {
    const turn: TranscriptTurn = {
      id: 1,
      prompt: "inspect",
      assistantText: "",
      statusLines: ["Flavoring"],
      blocks: [{
        kind: "status",
        id: "model:1",
        state: "running",
        text: "Flavoring",
        activity: "model",
        thinkingText: "Reading the project structure before choosing an implementation path.",
      }],
    };

    const html = renderToStaticMarkup(<DesktopTurnView turn={turn} active />);

    expect(html).toContain("data-activity=\"model\"");
    expect(html).toContain("正在思考");
    expect(html).toContain("class=\"reasoning-preview\"");
    expect(html).toContain("Reading the project structure");
  });

  it("keeps the newest tail in long desktop reasoning previews", () => {
    const preview = desktopThinkingPreview(`old ${"x".repeat(300)} newest`, 20);
    expect(preview.startsWith("…")).toBe(true);
    expect(preview.endsWith("newest")).toBe(true);
    expect(preview).toHaveLength(21);
  });

  it("renders historical tool input and result in a collapsed details region", () => {
    const turn: TranscriptTurn = {
      id: 1,
      prompt: "inspect",
      assistantText: "done",
      statusLines: ["✓ Read notes.md"],
      blocks: [{
        kind: "status",
        id: "tool:read",
        state: "completed",
        text: "✓ Read notes.md",
        tool: {
          name: "Read",
          input: { path: "notes.md" },
          result: { ok: true, output: { content: "restored contents" } },
        },
      }],
    };

    const html = renderToStaticMarkup(<DesktopTurnView turn={turn} />);

    expect(html).toContain("<details");
    expect(html).toContain("notes.md");
    expect(html).toContain("restored contents");
  });

  it("renders compacted legacy history as a distinct boundary card", () => {
    const turn: TranscriptTurn = {
      id: 1,
      kind: "compaction",
      prompt: "Earlier execution history was compacted",
      assistantText: "",
      statusLines: ["Original steps unavailable"],
      blocks: [{
        kind: "status",
        id: "compact-boundary",
        state: "info",
        tone: "warning",
        text: "Original steps unavailable",
        details: "Saved compact summary",
      }],
    };

    const html = renderToStaticMarkup(<DesktopTurnView turn={turn} />);

    expect(html).toContain("data-kind=\"compaction\"");
    expect(html).toContain("Saved compact summary");
  });

  it("bounds a very large active turn before building desktop DOM", () => {
    const turn: TranscriptTurn = {
      id: 9,
      prompt: "long task",
      assistantText: "",
      statusLines: [],
      blocks: Array.from({ length: 230 }, (_, index) => ({
        kind: "status" as const,
        id: `tool:${index}`,
        state: "completed" as const,
        text: `tool ${index}`,
      })),
    };

    const html = renderToStaticMarkup(<DesktopTurnView turn={turn} active />);
    expect(html).toContain("更早的 30 条任务输出");
    expect(html).not.toContain(">tool 0<");
    expect(html).toContain("tool 229");
  });
});
