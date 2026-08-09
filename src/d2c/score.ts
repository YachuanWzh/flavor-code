import type { D2cDiffResult, D2cPageSnapshot, D2cScores } from "./types.js";
import { rectArea } from "./types.js";

const WEIGHTS = { layout: 0.4, color: 0.3, typography: 0.15, pixel: 0.15 } as const;
const FULL_PENALTY_PX = 8;

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));

export function gradeFor(total: number): string {
  if (total >= 95) return "像素级还原";
  if (total >= 90) return "优秀";
  if (total >= 80) return "合格";
  return "需修复";
}

/**
 * Weighted similarity score. Layout and color are area-weighted over the design
 * page; typography covers matched text elements; pixel uses the screenshot
 * mismatch rate. Weights renormalize when the pixel score is unavailable.
 */
export function computeScores(
  design: D2cPageSnapshot,
  diff: D2cDiffResult,
  pixelMismatchRate: number | undefined,
): D2cScores {
  const baseArea = Math.max(1, design.elements.reduce((sum, element) => sum + rectArea(element.rect), 0));

  let penaltyArea = 0;
  for (const item of diff.diffs) {
    const maxOffset = Math.max(Math.abs(item.dx), Math.abs(item.dy), Math.abs(item.dw), Math.abs(item.dh));
    penaltyArea += rectArea(item.designRect) * clamp01(maxOffset / FULL_PENALTY_PX);
  }
  for (const item of diff.missing) penaltyArea += rectArea(item.rect);
  const layout = clamp01(1 - penaltyArea / baseArea);

  const colorMismatchArea = diff.diffs
    .filter((item) => item.colorIssues.length > 0)
    .reduce((sum, item) => sum + rectArea(item.designRect), 0);
  const color = clamp01(1 - colorMismatchArea / baseArea);

  const diffsByDesignId = new Map(diff.diffs.map((item) => [item.designId, item]));
  const textPairs = diff.matched.filter(({ design: expected }) => expected.text.trim() !== "");
  const consistentPairs = textPairs.filter(({ design: expected }) => {
    const item = diffsByDesignId.get(expected.id);
    return item === undefined || item.fontIssues.length === 0;
  });
  const typography = textPairs.length === 0 ? 1 : consistentPairs.length / textPairs.length;

  const pixel = pixelMismatchRate === undefined ? undefined : clamp01(1 - pixelMismatchRate);

  let weighted = layout * WEIGHTS.layout + color * WEIGHTS.color + typography * WEIGHTS.typography;
  let weightSum = WEIGHTS.layout + WEIGHTS.color + WEIGHTS.typography;
  if (pixel !== undefined) {
    weighted += pixel * WEIGHTS.pixel;
    weightSum += WEIGHTS.pixel;
  }
  const total = Math.round((100 * weighted) / weightSum * 10) / 10;
  return {
    layout: Math.round(layout * 10_000) / 10_000,
    color: Math.round(color * 10_000) / 10_000,
    typography: Math.round(typography * 10_000) / 10_000,
    ...(pixel === undefined ? {} : { pixel: Math.round(pixel * 10_000) / 10_000 }),
    total,
    grade: gradeFor(total),
  };
}
