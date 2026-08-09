import type { D2cElementSnapshot, D2cMatchedPair, D2cRect, D2cThresholds } from "./types.js";
import { D2C_DEFAULT_THRESHOLDS } from "./types.js";

export interface D2cAlignment {
  matched: D2cMatchedPair[];
  missing: D2cElementSnapshot[];
  extra: D2cElementSnapshot[];
}

/** Case/whitespace-insensitive text signature used as the strong matching signal. */
export function normalizeText(text: string): string {
  return text.trim().replace(/\s+/g, " ").toLowerCase();
}

export function intersectionOverUnion(a: D2cRect, b: D2cRect): number {
  const left = Math.max(a.x, b.x);
  const top = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  const intersection = Math.max(0, right - left) * Math.max(0, bottom - top);
  if (intersection === 0) return 0;
  const union = a.width * a.height + b.width * b.height - intersection;
  return union <= 0 ? 0 : intersection / union;
}

function groupByText(elements: readonly D2cElementSnapshot[]): Map<string, D2cElementSnapshot[]> {
  const groups = new Map<string, D2cElementSnapshot[]>();
  for (const element of elements) {
    const key = normalizeText(element.text);
    if (key === "") continue;
    const bucket = groups.get(key);
    if (bucket === undefined) groups.set(key, [element]);
    else bucket.push(element);
  }
  return groups;
}

/**
 * Two-stage alignment:
 * 1. Elements sharing an identical normalized text signature are paired first;
 *    duplicate texts resolve by best IoU within the group (position still decides,
 *    but a unique text match never fails on distance alone).
 * 2. Remaining elements pair greedily by descending IoU above the threshold.
 */
export function alignElements(
  design: readonly D2cElementSnapshot[],
  implementation: readonly D2cElementSnapshot[],
  thresholds: D2cThresholds = D2C_DEFAULT_THRESHOLDS,
): D2cAlignment {
  const matched: D2cMatchedPair[] = [];
  const usedDesign = new Set<D2cElementSnapshot>();
  const usedImpl = new Set<D2cElementSnapshot>();
  const pair = (d: D2cElementSnapshot, i: D2cElementSnapshot): void => {
    matched.push({ design: d, impl: i });
    usedDesign.add(d);
    usedImpl.add(i);
  };

  const designByText = groupByText(design);
  const implByText = groupByText(implementation);
  for (const [key, designGroup] of designByText) {
    const implGroup = implByText.get(key);
    if (implGroup === undefined) continue;
    const candidates: Array<{ d: D2cElementSnapshot; i: D2cElementSnapshot; iou: number }> = [];
    for (const d of designGroup) {
      for (const i of implGroup) candidates.push({ d, i, iou: intersectionOverUnion(d.rect, i.rect) });
    }
    candidates.sort((left, right) => right.iou - left.iou);
    for (const candidate of candidates) {
      if (usedDesign.has(candidate.d) || usedImpl.has(candidate.i)) continue;
      pair(candidate.d, candidate.i);
    }
  }

  const remainingDesign = design.filter((element) => !usedDesign.has(element));
  const remainingImpl = implementation.filter((element) => !usedImpl.has(element));
  const spatial: Array<{ d: D2cElementSnapshot; i: D2cElementSnapshot; iou: number }> = [];
  for (const d of remainingDesign) {
    for (const i of remainingImpl) {
      const iou = intersectionOverUnion(d.rect, i.rect);
      if (iou >= thresholds.iouMin) spatial.push({ d, i, iou });
    }
  }
  spatial.sort((left, right) => right.iou - left.iou);
  for (const candidate of spatial) {
    if (usedDesign.has(candidate.d) || usedImpl.has(candidate.i)) continue;
    pair(candidate.d, candidate.i);
  }

  return {
    matched,
    missing: design.filter((element) => !usedDesign.has(element)),
    extra: implementation.filter((element) => !usedImpl.has(element)),
  };
}
