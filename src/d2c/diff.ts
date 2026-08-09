import { alignElements, normalizeText } from "./align.js";
import { deltaE76, normalizeColor } from "./color.js";
import type {
  D2cColorIssue,
  D2cColorProperty,
  D2cDiffResult,
  D2cElementDiff,
  D2cElementSnapshot,
  D2cFontIssue,
  D2cPageSnapshot,
  D2cSeverity,
  D2cThresholds,
  D2cUnmatchedElement,
} from "./types.js";
import { D2C_DEFAULT_THRESHOLDS } from "./types.js";

const MAJOR_COLOR_DELTA_E = 12;
const LABEL_TEXT_LIMIT = 24;

export function elementLabel(element: D2cElementSnapshot): string {
  const text = element.text.trim();
  if (text !== "") {
    const clipped = text.length > LABEL_TEXT_LIMIT ? `${text.slice(0, LABEL_TEXT_LIMIT)}…` : text;
    return `${element.tag} "${clipped}"`;
  }
  const { x, y, width, height } = element.rect;
  return `${element.tag} @(${Math.round(x)},${Math.round(y)} ${Math.round(width)}×${Math.round(height)})`;
}

function normalizeFontWeight(weight: string | undefined): string | undefined {
  if (weight === undefined) return undefined;
  const value = weight.trim().toLowerCase();
  if (value === "" ) return undefined;
  if (value === "normal") return "400";
  if (value === "bold") return "700";
  return value;
}

function normalizeFontFamily(family: string | undefined): string | undefined {
  if (family === undefined) return undefined;
  const primary = family.split(",")[0]?.trim().replace(/^["']|["']$/g, "").toLowerCase();
  return primary === "" || primary === undefined ? undefined : primary;
}

function colorIssues(
  design: D2cElementSnapshot,
  impl: D2cElementSnapshot,
  thresholds: D2cThresholds,
): D2cColorIssue[] {
  const issues: D2cColorIssue[] = [];
  for (const property of ["color", "backgroundColor"] as const satisfies readonly D2cColorProperty[]) {
    const expected = normalizeColor(design.styles[property] ?? "");
    const actual = normalizeColor(impl.styles[property] ?? "");
    if (expected === undefined || actual === undefined || expected === actual) continue;
    const deltaE = deltaE76(expected, actual);
    if (deltaE > thresholds.colorDeltaE) {
      issues.push({ property, expected, actual, deltaE: Math.round(deltaE * 10) / 10 });
    }
  }
  return issues;
}

function fontIssues(design: D2cElementSnapshot, impl: D2cElementSnapshot): D2cFontIssue[] {
  if (design.text.trim() === "") return [];
  const issues: D2cFontIssue[] = [];
  if (design.styles.fontSize !== undefined && impl.styles.fontSize !== undefined
    && design.styles.fontSize !== impl.styles.fontSize) {
    issues.push({ property: "fontSize", expected: String(design.styles.fontSize), actual: String(impl.styles.fontSize) });
  }
  const designWeight = normalizeFontWeight(design.styles.fontWeight);
  const implWeight = normalizeFontWeight(impl.styles.fontWeight);
  if (designWeight !== undefined && implWeight !== undefined && designWeight !== implWeight) {
    issues.push({ property: "fontWeight", expected: designWeight, actual: implWeight });
  }
  const designFamily = normalizeFontFamily(design.styles.fontFamily);
  const implFamily = normalizeFontFamily(impl.styles.fontFamily);
  if (designFamily !== undefined && implFamily !== undefined && designFamily !== implFamily) {
    issues.push({ property: "fontFamily", expected: designFamily, actual: implFamily });
  }
  return issues;
}

function unmatched(element: D2cElementSnapshot): D2cUnmatchedElement {
  return { id: element.id, label: elementLabel(element), rect: element.rect };
}

/** Compares two rendered pages and produces per-element diffs plus unmatched lists. */
export function diffPages(
  design: D2cPageSnapshot,
  implementation: D2cPageSnapshot,
  thresholds: D2cThresholds = D2C_DEFAULT_THRESHOLDS,
): D2cDiffResult {
  const alignment = alignElements(design.elements, implementation.elements, thresholds);
  const diffs: D2cElementDiff[] = [];
  for (const { design: expected, impl: actual } of alignment.matched) {
    const dx = actual.rect.x - expected.rect.x;
    const dy = actual.rect.y - expected.rect.y;
    const dw = actual.rect.width - expected.rect.width;
    const dh = actual.rect.height - expected.rect.height;
    const maxOffset = Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dw), Math.abs(dh));
    const geometryIssue = maxOffset > thresholds.geometryTolerancePx;
    const colors = colorIssues(expected, actual, thresholds);
    const fonts = fontIssues(expected, actual);
    const expectedText = normalizeText(expected.text);
    const actualText = normalizeText(actual.text);
    const textIssue = expectedText === actualText
      ? undefined
      : { expected: expected.text.trim(), actual: actual.text.trim() };
    const imageIssue = expected.hasImage === actual.hasImage
      ? undefined
      : { expected: expected.hasImage, actual: actual.hasImage };
    if (!geometryIssue && colors.length === 0 && fonts.length === 0
      && textIssue === undefined && imageIssue === undefined) continue;
    const severity: D2cSeverity = maxOffset > thresholds.fullPenaltyPx
      || colors.some((issue) => issue.deltaE > MAJOR_COLOR_DELTA_E)
      || textIssue !== undefined
      || imageIssue !== undefined
      ? "major"
      : "minor";
    diffs.push({
      designId: expected.id,
      implId: actual.id,
      label: elementLabel(expected),
      designRect: expected.rect,
      implRect: actual.rect,
      dx, dy, dw, dh,
      colorIssues: colors,
      fontIssues: fonts,
      ...(textIssue === undefined ? {} : { textIssue }),
      ...(imageIssue === undefined ? {} : { imageIssue }),
      severity,
    });
  }
  diffs.sort((left, right) => {
    if (left.severity !== right.severity) return left.severity === "major" ? -1 : 1;
    const leftArea = left.designRect.width * left.designRect.height;
    const rightArea = right.designRect.width * right.designRect.height;
    return rightArea - leftArea;
  });
  return {
    matched: alignment.matched,
    diffs,
    missing: alignment.missing.map(unmatched),
    extra: alignment.extra.map(unmatched),
  };
}
