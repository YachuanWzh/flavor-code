import { charWidth } from "./char-width.js";

/**
 * Display model for the streamed thinking line.
 *
 * The line occupies a fixed cell width. Text is revealed like a typewriter:
 * while it fits, the whole text is shown. Once it overflows, the viewport
 * chases the newest tail — content visibly pushes left. The chase eases so a
 * burst of tokens does not jerk the line, and it always converges on the tail
 * so the freshest reasoning stays readable.
 */

export const THINKING_SCROLL_CELLS_PER_SEC = 16;
/** Exponential catch-up factor applied to the remaining lag each update. */
export const THINKING_EASE = 0.18;
/** Caps one update's elapsed time so a paused clock cannot jump the scroll. */
export const THINKING_MAX_STEP_MS = 250;
/** Cap for stored thinking text per model activity (characters). */
export const THINKING_MAX_STORED_CHARS = 4_000;

export interface ThinkingWindowOptions {
  /** Visible width in terminal cells. */
  width: number;
  /** Milliseconds since the previous update. */
  dtMs: number;
  cellsPerSecond?: number;
  ease?: number;
}

export interface ThinkingWindowState {
  /** The slice to render in the fixed-width slot. */
  text: string;
  /** Scroll offset in cells; feed back as `previousStart` next update. */
  start: number;
}

export function normalizeThinkingText(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

export function thinkingDisplayWidth(text: string): number {
  let width = 0;
  for (const character of text) width += charWidth(character.codePointAt(0) ?? 32);
  return width;
}

/** Slice a display-width window out of text; wide chars straddling an edge are kept whole. */
export function sliceThinkingByWidth(text: string, startCell: number, cellCount: number): string {
  let out = "";
  let cell = 0;
  for (const character of text) {
    const w = charWidth(character.codePointAt(0) ?? 32);
    if (cell + w > startCell && cell < startCell + cellCount) out += character;
    cell += w;
    if (cell >= startCell + cellCount) break;
  }
  return out;
}

/**
 * Advance the fixed-width viewport toward the newest tail by one update.
 * `previousStart` carries the scroll position from the last frame so the
 * movement is rate-limited rather than an instant jump.
 */
export function thinkingWindow(
  text: string,
  previousStart: number,
  options: ThinkingWindowOptions,
): ThinkingWindowState {
  const normalized = normalizeThinkingText(text);
  const width = Math.max(1, Math.floor(options.width));
  const total = thinkingDisplayWidth(normalized);
  if (total <= width) return { text: normalized, start: 0 };
  const maxStart = total - width;
  const from = Math.min(Math.max(0, previousStart), maxStart);
  const cellsPerSecond = options.cellsPerSecond ?? THINKING_SCROLL_CELLS_PER_SEC;
  const ease = options.ease ?? THINKING_EASE;
  const dt = Math.max(0, Math.min(options.dtMs, THINKING_MAX_STEP_MS));
  const lag = maxStart - from;
  const step = Math.max((cellsPerSecond * dt) / 1_000, lag * ease);
  const start = Math.min(maxStart, Math.floor(from + step));
  return { text: sliceThinkingByWidth(normalized, start, width), start };
}

/** Append a thinking delta, keeping only the tail of the accumulated text. */
export function appendThinkingText(previous: string | undefined, delta: string): string {
  const next = (previous ?? "") + delta;
  return next.length > THINKING_MAX_STORED_CHARS ? next.slice(-THINKING_MAX_STORED_CHARS) : next;
}
