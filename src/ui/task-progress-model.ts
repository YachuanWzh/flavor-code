import type { TranscriptBlock } from "./transcript.js";
import type { TaskSnapshot } from "../agent/types.js";
import type { Color } from "../claude-ink/styles.js";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

export interface StatusPresentation {
  glyph: string;
  text: string;
  color?: Color;
  badge?: string;
  badgeColor?: Color;
  /** The status word rendered after " · " (e.g. "running", "pending", "done"). */
  statusLabel?: string;
  /** Color override for statusLabel.  When undefined, inherits from `color`. */
  statusColor?: Color;
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
    lines.push(`${glyph} subagent: ${node.description} · ${status}`);
  }
  return lines;
}

export function statusPresentation(
  block: Extract<TranscriptBlock, { kind: "status" }>,
  elapsedMs: number,
  interactive: boolean,
): StatusPresentation {
  if (block.state === "running" && block.task !== undefined) {
    const isSubagent = block.task.role === "subagent";
    const activeForm = block.task.activeForm;
    return interactive ? {
      glyph: activityFrame(elapsedMs),
      text: `${activeForm}… (${formatElapsed(elapsedMs)})`,
      color: "#d77757",
      ...(isSubagent ? { badge: "subagent:", badgeColor: "#81c8f2" as Color } : {}),
    } : {
      glyph: "·",
      text: isSubagent ? `${activeForm} · running` : activeForm,
      ...(isSubagent ? { badge: "subagent:", badgeColor: "#81c8f2" as Color,
        statusLabel: "running", statusColor: "#d77757" as Color } : {}),
    };
  }
  const duration = block.elapsedMs === undefined ? "" : ` (${formatElapsed(block.elapsedMs)})`;
  const isSubagent = block.task?.role === "subagent";
  const label = statusLabelForState(block.state);
  const statusColor = label === undefined ? undefined : statusColorForLabel(label);
  if (block.state === "completed") {
    return { glyph: "✓", text: `${stripSubagentPrefix(withoutGlyph(block.text), isSubagent)}${duration}`, color: "ansi:green",
      ...(isSubagent ? { badge: "subagent:", badgeColor: "#81c8f2" as Color } : {}),
      ...(label === undefined ? {} : { statusLabel: label, statusColor }),
    };
  }
  if (block.state === "failed" || block.state === "cancelled") {
    return { glyph: "×", text: `${stripSubagentPrefix(withoutGlyph(block.text), isSubagent)}${duration}`, color: "#e06c50",
      ...(isSubagent ? { badge: "subagent:", badgeColor: "#81c8f2" as Color } : {}),
      ...(label === undefined ? {} : { statusLabel: label, statusColor }),
    };
  }
  return { glyph: "·", text: stripSubagentPrefix(withoutGlyph(block.text), isSubagent),
    ...(isSubagent ? { badge: "subagent:", badgeColor: "#81c8f2" as Color } : {}),
    ...(label === undefined ? {} : { statusLabel: label, statusColor }),
  };
}

function statusLabelForState(state: string): string | undefined {
  if (state === "running") return "running";
  if (state === "completed") return "done";
  if (state === "failed") return "failed";
  if (state === "cancelled") return "cancelled";
  if (state === "info") return "pending";
  return undefined;
}

function statusColorForLabel(label: string): Color | undefined {
  if (label === "running") return "#d77757";
  if (label === "pending") return "ansi:blackBright";
  // done / failed / cancelled — blend with surrounding text
  return undefined;
}

function withoutGlyph(text: string): string {
  return text.replace(/^[✓×○·]\s*/u, "");
}

function stripSubagentPrefix(text: string, isSubagent: boolean): string {
  return isSubagent ? text.replace(/^subagent:\s*/u, "") : text;
}
