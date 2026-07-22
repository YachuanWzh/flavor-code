import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { DesktopTurnView } from "../../src/desktop/renderer/app.js";
import type { TranscriptTurn } from "../../src/ui/transcript.js";

describe("desktop restored timeline rendering", () => {
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
});
