import type { FileChangePresentation, FileDiffLine } from "./types.js";

export const MAX_DIFF_PREVIEW_LINES = 120;
const CONTEXT_LINES = 3;

export interface DiffHunkInput {
  oldStart: number;
  newStart: number;
  lines: readonly string[];
}

export function buildFileChangePresentation(
  path: string,
  before: string,
  after: string,
  operation: "create" | "update",
): FileChangePresentation {
  const oldLines = sourceLines(before);
  const newLines = sourceLines(after);
  const lines = operation === "create"
    ? newLines.map((text, index): FileDiffLine => ({ kind: "added", newLine: index + 1, text }))
    : contiguousDiff(oldLines, newLines);
  const added = lines.filter((line) => line.kind === "added").length;
  const removed = lines.filter((line) => line.kind === "removed").length;
  return {
    kind: "file-change",
    operation,
    path,
    added,
    removed,
    lines: truncateLines(lines),
  };
}

export function buildPatchPresentation(
  path: string,
  created: boolean,
  hunks: readonly DiffHunkInput[],
): FileChangePresentation {
  const lines: FileDiffLine[] = [];
  let added = 0;
  let removed = 0;
  for (const hunk of hunks) {
    let oldLine = hunk.oldStart;
    let newLine = hunk.newStart;
    for (const raw of hunk.lines) {
      const prefix = raw[0];
      const text = raw.slice(1);
      if (prefix === " ") {
        lines.push({ kind: "context", oldLine, newLine, text });
        oldLine += 1;
        newLine += 1;
      } else if (prefix === "-") {
        lines.push({ kind: "removed", oldLine, text });
        oldLine += 1;
        removed += 1;
      } else if (prefix === "+") {
        lines.push({ kind: "added", newLine, text });
        newLine += 1;
        added += 1;
      }
    }
  }
  return {
    kind: "file-change",
    operation: created ? "create" : "update",
    path,
    added,
    removed,
    lines: truncateLines(lines),
  };
}

function contiguousDiff(oldLines: readonly string[], newLines: readonly string[]): FileDiffLine[] {
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix += 1;

  let suffix = 0;
  while (
    suffix < oldLines.length - prefix
    && suffix < newLines.length - prefix
    && oldLines[oldLines.length - suffix - 1] === newLines[newLines.length - suffix - 1]
  ) suffix += 1;

  const oldChangeEnd = oldLines.length - suffix;
  const newChangeEnd = newLines.length - suffix;
  const lines: FileDiffLine[] = [];
  const leadingStart = Math.max(0, prefix - CONTEXT_LINES);
  for (let index = leadingStart; index < prefix; index += 1) {
    lines.push({ kind: "context", oldLine: index + 1, newLine: index + 1, text: oldLines[index]! });
  }
  for (let index = prefix; index < oldChangeEnd; index += 1) {
    lines.push({ kind: "removed", oldLine: index + 1, text: oldLines[index]! });
  }
  for (let index = prefix; index < newChangeEnd; index += 1) {
    lines.push({ kind: "added", newLine: index + 1, text: newLines[index]! });
  }
  const trailingCount = Math.min(CONTEXT_LINES, suffix);
  for (let offset = 0; offset < trailingCount; offset += 1) {
    const oldIndex = oldChangeEnd + offset;
    const newIndex = newChangeEnd + offset;
    lines.push({
      kind: "context",
      oldLine: oldIndex + 1,
      newLine: newIndex + 1,
      text: oldLines[oldIndex]!,
    });
  }
  return lines;
}

function sourceLines(value: string): string[] {
  if (value.length === 0) return [];
  const lines = value.replaceAll("\r\n", "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function truncateLines(lines: readonly FileDiffLine[]): FileDiffLine[] {
  if (lines.length <= MAX_DIFF_PREVIEW_LINES) return [...lines];
  const visible = MAX_DIFF_PREVIEW_LINES - 1;
  const head = Math.ceil(visible / 2);
  const tail = Math.floor(visible / 2);
  const hidden = lines.length - visible;
  return [
    ...lines.slice(0, head),
    { kind: "omitted", text: `… ${hidden} lines hidden` },
    ...lines.slice(lines.length - tail),
  ];
}
