import type { TranscriptBlock } from "./transcript.js";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

export interface StatusPresentation {
  glyph: string;
  text: string;
  color?: "yellow" | "green" | "red";
}

export function activityFrame(elapsedMs: number): string {
  return FRAMES[Math.floor(Math.max(0, elapsedMs) / 120) % FRAMES.length]!;
}

export function formatElapsed(elapsedMs: number): string {
  return `${Math.floor(Math.max(0, elapsedMs) / 1_000)}s`;
}

export function statusPresentation(
  block: Extract<TranscriptBlock, { kind: "status" }>,
  elapsedMs: number,
  interactive: boolean,
): StatusPresentation {
  if (block.state === "running" && block.task !== undefined) {
    return interactive ? {
      glyph: activityFrame(elapsedMs),
      text: `${block.task.activeForm}… (${formatElapsed(elapsedMs)})`,
      color: "yellow",
    } : {
      glyph: "·",
      text: block.task.activeForm,
    };
  }
  if (block.state === "completed") return { glyph: "✓", text: withoutGlyph(block.text), color: "green" };
  if (block.state === "failed" || block.state === "cancelled") {
    return { glyph: "×", text: withoutGlyph(block.text), color: "red" };
  }
  return { glyph: "·", text: withoutGlyph(block.text) };
}

function withoutGlyph(text: string): string {
  return text.replace(/^[✓×✦└·›]\s*/u, "");
}
