/**
 * Build the DECSTBM (`\x1B[1;${rows}r`) escape sequence that restricts the
 * scrolling region to rows `1..rows`. Anything written outside this region
 * (e.g. the bottom prompt area) is unaffected.
 *
 * Exported as a pure function so it can be unit-tested without rendering.
 */
export function buildScrollRegionEscape(rows: number): string {
  return `\x1B[1;${rows}r`;
}

/** Reset the scrolling region to the entire screen. */
export const RESET_SCROLL_REGION = "\x1B[r";

/** Sequence to hide the cursor while we mutate the terminal state. */
export const HIDE_CURSOR = "\x1B[?25l";

/** Sequence to restore the cursor after a terminal mutation. */
export const SHOW_CURSOR = "\x1B[?25h";

/** Move cursor to absolute position (row, column) — used for sanity. */
export function moveCursor(row: number, column: number): string {
  return `\x1B[${row};${column}H`;
}
