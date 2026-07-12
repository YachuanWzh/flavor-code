/**
 * A streaming region managed entirely through raw ANSI escapes.
 *
 * Why this exists: routing streamed assistant text through React/Ink means
 * every text event triggers a reconciliation, and Ink's incremental
 * rendering issues cursor-position / line-clear escapes that the user reads
 * as a per-character flash. The fix is to keep the streamed text out of
 * React state entirely while it's being generated — write the bytes to
 * `stdout` directly, advance a virtual cursor, and only hand the full
 * accumulated text back to React once the stream ends.
 *
 * DECSTBM (the `ESC[top;bottom r` escape that sets a scroll region) lives
 * in the App component because it changes with geometry — this file only
 * owns the cursor bookkeeping and write paths.
 *
 * The cursor inside the band is tracked in code (not from the terminal)
 * so Ink's static paints between chunks don't sneak the cursor somewhere
 * else; we always reposition before writing.
 */

import { charWidth } from "./char-width.js";

export interface RawStreamOptions {
  stdout: NodeJS.WriteStream | undefined;
  /** First row of the streaming band, 1-based (header sits on row 1). */
  topRow: number;
  /** Total terminal columns (`process.stdout.columns`). */
  columns: number;
  /**
   * Number of rows in the streaming band (the height of the scroll region).
   * Used to clamp cursor positioning so writes never escape into the prompt
   * area when the terminal auto-scrolls content within DECSTBM.
   * When omitted, no clamping is applied (existing test behavior).
   */
  maxRows?: number;
}

export interface RawStreamHandle {
  /** Begin a new stream. Resets the cursor to the band's top-left. */
  start(): void;
  /** Write `chunk` at the current cursor and advance the virtual cursor. */
  append(chunk: string): void;
  /** End the current stream and return the accumulated full text. */
  finalize(): string;
  /** Discard the current stream. */
  reset(): void;
  /** Whether a stream is currently open. */
  readonly active: boolean;
}

export function createRawStream(options: RawStreamOptions): RawStreamHandle {
  const { stdout, topRow, columns, maxRows } = options;
  const width = Math.max(1, columns);
  /** Last valid row index inside the band (0-based, relative to topRow).
   *  Infinity when maxRows is not set (no clamping). */
  const maxBandRow = maxRows !== undefined ? Math.max(1, maxRows) - 1 : Infinity;
  let active = false;
  let buffer = "";
  /** Row inside the band where the next character will be written. */
  let cursorRow = 0;
  /** Column inside the band where the next character will be written. */
  let cursorCol = 1;
  /** Accumulated content for redrawing when the band overflows. */
  let contentBuffer = "";

  const write = (text: string): void => {
    if (stdout === undefined || typeof stdout.write !== "function") return;
    try { stdout.write(text); }
    catch { /* stdout may be closed mid-shutdown */ }
  };

  const moveTo = (row: number, col: number): void => {
    write(`\x1B[${row};${col}H`);
  };

  const positionCursor = (): void => {
    // Clamp the row so we never position outside the scroll region. When the
    // terminal has already auto-scrolled the content, the cursor is still at
    // the bottom of the DECSTBM region — writing outside it would overwrite
    // the prompt area.
    const clampedRow = Math.min(cursorRow, maxBandRow);
    moveTo(topRow + clampedRow, cursorCol);
  };

  // The terminal advances the cursor after each character we write. We mirror
  // that here so the next call to `positionCursor` lines up with where the
  // terminal will actually place the next glyph.
  //
  // CJK ideographs, emoji, and other wide characters occupy 2 terminal columns;
  // we use `charWidth()` to track the actual column offset.
  //
  // IMPORTANT: cursorRow is NOT clamped to maxBandRow here. When it exceeds
  // maxBandRow, `append()` detects the overflow and redraws the visible band.
  // This avoids the old bug where positionCursor() would reposition to the
  // bottom row and overwrite existing content after the terminal auto-scrolled.
  const advance = (chunk: string): void => {
    for (const ch of chunk) {
      if (ch === "\n") {
        cursorRow += 1;
        cursorCol = 1;
      } else {
        const w = charWidth(ch.codePointAt(0) ?? 0);
        if (cursorCol + w > width) {
          // Terminal wraps this character to the next line.
          cursorRow += 1;
          cursorCol = 1;
          // If the wide character itself was placed at the start of the
          // wrapped line, its width still advances the cursor.
          if (w <= width) cursorCol += w;
        } else {
          cursorCol += w;
        }
      }
    }
  };

  /**
   * Split text into visual lines respecting the terminal width, using
   * charWidth() for correct CJK/wide-character handling.
   */
  const splitVisualLines = (text: string): string[] => {
    const result: string[] = [];
    for (const logicalLine of text.split("\n")) {
      const points = [...logicalLine];
      let lineStart = 0;
      let lineWidth = 0;
      for (let j = 0; j < points.length; j++) {
        const w = charWidth(points[j]!.codePointAt(0) ?? 0);
        if (lineWidth + w > width && j > lineStart) {
          result.push(points.slice(lineStart, j).join(""));
          lineStart = j;
          lineWidth = w;
        } else {
          lineWidth += w;
        }
      }
      result.push(points.slice(lineStart).join(""));
    }
    return result;
  };

  /**
   * Redraw the visible portion of the band when content overflows.
   * Called when cursorRow exceeds maxBandRow — we take the last maxBandRow+1
   * visual lines from the content buffer and paint them into the band using
   * absolute cursor positioning (no newlines, so no DECSTBM scroll side-effects).
   */
  const redrawBand = (): void => {
    const allLines = splitVisualLines(contentBuffer);
    const bandSize = maxBandRow + 1;
    const visibleLines = allLines.length > bandSize ? allLines.slice(allLines.length - bandSize) : allLines;

    // Align to the bottom of the band — empty rows (if any) sit at the top.
    const startRow = topRow + maxBandRow - visibleLines.length + 1;

    for (let i = 0; i < visibleLines.length; i++) {
      const row = startRow + i;
      moveTo(row, 1);
      write("\x1B[2K");            // clear entire line
      write(visibleLines[i] ?? "");
    }
    // Clear any remaining rows below the content (shouldn't happen when
    // visibleLines fills the band, but guards against edge cases).
    for (let row = startRow + visibleLines.length; row <= topRow + maxBandRow; row++) {
      moveTo(row, 1);
      write("\x1B[2K");
    }

    // Place the cursor at the correct position within the last visible line.
    moveTo(topRow + maxBandRow, Math.max(1, cursorCol));
  };

  return {
    get active() { return active; },
    start() {
      buffer = "";
      contentBuffer = "";
      cursorRow = 0;
      cursorCol = 1;
      active = true;
    },
    append(chunk: string) {
      if (!active) this.start();
      if (chunk.length === 0) return;

      // Predict whether this chunk would push the cursor past the visible
      // band. If so, skip the direct write (it would overwrite the bottom
      // line) and instead update internal state + redraw the visible portion.
      const savedRow = cursorRow;
      const savedCol = cursorCol;
      advance(chunk);
      buffer += chunk;
      contentBuffer += chunk;

      if (cursorRow > maxBandRow) {
        // Overflow — redraw the entire visible band from the content buffer.
        redrawBand();
      } else {
        // No overflow — restore cursor and do the normal write path.
        cursorRow = savedRow;
        cursorCol = savedCol;
        positionCursor();
        write(chunk);
        advance(chunk);
      }
    },
    finalize() {
      if (!active) return "";
      const full = buffer;
      buffer = "";
      contentBuffer = "";
      active = false;
      cursorRow = 0;
      cursorCol = 1;
      return full;
    },
    reset() {
      buffer = "";
      contentBuffer = "";
      cursorRow = 0;
      cursorCol = 1;
      active = false;
    },
  };
}
