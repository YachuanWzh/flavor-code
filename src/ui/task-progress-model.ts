import type { TranscriptBlock } from "./transcript.js";
import type { TaskSnapshot } from "../agent/types.js";
import type { Color } from "../claude-ink/styles.js";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

export interface StatusPresentation {
  glyph: string;
  text: string;
  color?: Color;
}

export function activityFrame(elapsedMs: number): string {
  return FRAMES[Math.floor(Math.max(0, elapsedMs) / 120) % FRAMES.length]!;
}

export function formatElapsed(elapsedMs: number): string {
  return `${Math.floor(Math.max(0, elapsedMs) / 1_000)}s`;
}

export function staticTaskLines(snapshot: TaskSnapshot): string[] {
  const lines = (snapshot.plan?.tasks ?? []).map((task) => {
    const glyph = task.status === "completed" ? "✓"
      : task.status === "failed" || task.status === "blocked" || task.status === "cancelled" ? "×" : "·";
    const label = task.status === "in_progress" ? task.activeForm : task.subject;
    const status = task.status === "in_progress" ? "running" : task.status === "completed" ? "done" : task.status.replace("_", " ");
    return `${glyph} ${label} · ${status}`;
  });
  for (const node of snapshot.subagents.graph?.nodes ?? []) {
    const status = snapshot.subagents.states[node.id] ?? "pending";
    const glyph = status === "completed" ? "✓" : status === "failed" || status === "blocked" || status === "cancelled" ? "×" : "·";
    lines.push(`${glyph} ${node.description} / subagent · ${status}`);
  }
  return lines;
}

export function statusPresentation(
  block: Extract<TranscriptBlock, { kind: "status" }>,
  elapsedMs: number,
  interactive: boolean,
): StatusPresentation {
  if (block.state === "running" && block.task !== undefined) {
    const activeForm = block.task.role === "subagent"
      ? `${block.task.activeForm} / subagent`
      : block.task.activeForm;
    return interactive ? {
      glyph: activityFrame(elapsedMs),
      text: `${activeForm}… (${formatElapsed(elapsedMs)})`,
      color: "#d77757",
    } : {
      glyph: "·",
      text: activeForm,
    };
  }
  const duration = block.elapsedMs === undefined ? "" : ` (${formatElapsed(block.elapsedMs)})`;
  if (block.state === "completed") return { glyph: "✓", text: `${withoutGlyph(block.text)}${duration}`, color: "ansi:green" };
  if (block.state === "failed" || block.state === "cancelled") {
    return { glyph: "×", text: `${withoutGlyph(block.text)}${duration}`, color: "#e06c50" };
  }
  return { glyph: "·", text: withoutGlyph(block.text) };
}

function withoutGlyph(text: string): string {
  return text.replace(/^[✓×○·]\s*/u, "");
}
