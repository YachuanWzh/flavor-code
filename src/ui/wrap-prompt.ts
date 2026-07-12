/**
 * Wrap an input string into the available terminal columns for the prompt
 * line. Computes the visual line and column of the cursor so callers can
 * place the inverse cursor in exactly the right cell.
 *
 * Code-point based — full Unicode (emoji, CJK, etc.) is preserved. Column
 * tracking uses {@link charWidth} so CJK ideographs and emoji (2 columns)
 * are accounted for correctly.
 *
 * Exported as a pure helper so it can be unit-tested without rendering.
 */

import { charWidth } from "./char-width.js";

export interface WrapCursor { line: number; column: number; }
export interface WrapPrompt {
  lines: string[];
  cursor: WrapCursor;
  /** Total visual height consumed by the wrapped content (in terminal rows). */
  height: number;
}

export interface WrapPromptOptions {
  /** Usable width in columns (terminal width minus the "› " prompt gutter). */
  columns: number;
  /** Hint for the prompt's left-side gutter; default 2 ("› "). */
  indent?: number;
}

export function wrapPromptInput(
  input: string,
  codePointCursor: number,
  options: WrapPromptOptions,
): WrapPrompt {
  const indent = Math.max(0, options.indent ?? 2);
  const columns = Math.max(1, options.columns);
  const usable = Math.max(1, columns - indent);
  const points = [...input];
  const len = points.length;
  const clamped = Math.max(0, Math.min(len, codePointCursor));

  const lines: string[] = [];
  let i = 0;
  while (i < len) {
    let lineVisualWidth = 0;
    const lineStart = i;
    while (i < len) {
      const cp = points[i]!.codePointAt(0) ?? 0;
      const cw = charWidth(cp);
      if (lineVisualWidth + cw > usable) break;
      lineVisualWidth += cw;
      i += 1;
    }
    // Safety: if a single character is wider than the usable width
    // (rare, but prevents an infinite loop on extremely narrow terminals),
    // force it onto its own line.
    if (i === lineStart) i += 1;
    lines.push(points.slice(lineStart, i).join(""));
  }
  if (lines.length === 0) lines.push("");

  // Locate the cursor's line + column.
  let cursor: WrapCursor = { line: 0, column: 0 };
  let consumed = 0;
  for (let line = 0; line < lines.length; line += 1) {
    const lineLength = [...lines[line] ?? ""].length;
    const next = consumed + lineLength;
    if (clamped <= next) {
      cursor = { line, column: clamped - consumed };
      break;
    }
    consumed = next;
  }

  return { lines, cursor, height: lines.length };
}

/** Compute the inverse-cursor glyph at a given visual position. */
export function cursorGlyph(input: string, columns: number, codePointCursor: number, indent = 2): {
  line: string;
  column: number;
  glyph: string;
  remainder: string;
  prefix: string;
} {
  const wrap = wrapPromptInput(input, codePointCursor, { columns, indent });
  const idx = wrap.cursor.line;
  const lines = wrap.lines;
  const line = lines[idx] ?? "";
  const points = [...line];
  const col = wrap.cursor.column;
  const prefix = points.slice(0, col).join("");
  const glyph = points[col] ?? " ";
  const remainder = points.slice(col + 1).join("");
  return { line, column: col, glyph, remainder, prefix };
}
