import type { Buffer } from "node:buffer";

export interface D2cRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface D2cElementStyles {
  /** Normalized #rrggbb (or raw value before normalization). */
  color?: string;
  backgroundColor?: string;
  fontSize?: number;
  fontWeight?: string;
  fontFamily?: string;
}

export interface D2cElementSnapshot {
  id: number;
  tag: string;
  /** Trimmed direct text content; empty for pure containers/images. */
  text: string;
  rect: D2cRect;
  styles: D2cElementStyles;
  hasImage: boolean;
  /** Stable CSS-like locator captured from the rendered document. */
  selector?: string;
}

export interface D2cPageSnapshot {
  width: number;
  height: number;
  elements: readonly D2cElementSnapshot[];
}

export interface D2cThresholds {
  /** Geometry differences within this many px are not reported. */
  geometryTolerancePx: number;
  /** Offset magnitude that incurs the full layout penalty. */
  fullPenaltyPx: number;
  /** CIE76 ΔE above which two colors count as different. */
  colorDeltaE: number;
  /** Minimum intersection-over-union for spatial matching. */
  iouMin: number;
}

export const D2C_DEFAULT_THRESHOLDS: D2cThresholds = Object.freeze({
  geometryTolerancePx: 2,
  fullPenaltyPx: 8,
  colorDeltaE: 3,
  iouMin: 0.3,
});

export type D2cColorProperty = "color" | "backgroundColor";

export interface D2cColorIssue {
  property: D2cColorProperty;
  expected: string;
  actual: string;
  deltaE: number;
}

export interface D2cFontIssue {
  property: "fontSize" | "fontWeight" | "fontFamily";
  expected: string;
  actual: string;
}

export type D2cSeverity = "minor" | "major";

export interface D2cElementDiff {
  designId: number;
  implId: number;
  label: string;
  designRect: D2cRect;
  implRect: D2cRect;
  dx: number;
  dy: number;
  dw: number;
  dh: number;
  colorIssues: D2cColorIssue[];
  fontIssues: D2cFontIssue[];
  textIssue?: { expected: string; actual: string };
  imageIssue?: { expected: boolean; actual: boolean };
  severity: D2cSeverity;
  /** Stable across runs when the same semantic issue remains. */
  fingerprint: string;
  /** Product-facing priority from 1 (low) to 10 (blocking). */
  impact: number;
  designSelector?: string;
  implementationSelector?: string;
}

export interface D2cUnmatchedElement {
  id: number;
  label: string;
  rect: D2cRect;
  text: string;
  hasImage: boolean;
  selector?: string;
  fingerprint: string;
  impact: number;
  severity: D2cSeverity;
}

export interface D2cMatchedPair {
  design: D2cElementSnapshot;
  impl: D2cElementSnapshot;
}

export interface D2cDiffResult {
  matched: D2cMatchedPair[];
  diffs: D2cElementDiff[];
  /** Present in the design but absent from the implementation. */
  missing: D2cUnmatchedElement[];
  /** Present in the implementation but absent from the design. */
  extra: D2cUnmatchedElement[];
}

export interface D2cScores {
  layout: number;
  color: number;
  typography: number;
  /** Semantic text and image fidelity. */
  content: number;
  /** Undefined when no screenshot comparison was performed. */
  pixel?: number;
  total: number;
  grade: string;
}

export interface D2cCaptureDiagnostics {
  devicePixelRatio: number;
  fontsReady: boolean;
  imageCount: number;
  failedImages: number;
  naturalWidth: number;
  naturalHeight: number;
  clipped: boolean;
}

export type D2cProgressStage =
  | "prepare"
  | "dependencies"
  | "server"
  | "capture-design"
  | "capture-implementation"
  | "pixel-diff"
  | "report";

export interface D2cProgressEvent {
  task: string;
  /** One-based comparison attempt within the current desktop runtime. */
  cycle: number;
  stage: D2cProgressStage;
  state: "running" | "completed" | "failed";
  message: string;
  cached?: boolean;
}

export type D2cCheckStatus = "pass" | "warn" | "fail";

export interface D2cValidityCheck {
  key: "viewport" | "dpr" | "fonts" | "images" | "clipping" | "capture-metadata";
  label: string;
  status: D2cCheckStatus;
  message: string;
}

export interface D2cEvaluation {
  status: "valid" | "warning" | "invalid";
  confidence: "high" | "medium" | "low";
  verdict: "pass" | "conditional" | "fail" | "invalid";
  summary: string;
  checks: D2cValidityCheck[];
}

export interface D2cReport {
  schema: 2;
  task: string;
  reportId: string;
  /** Groups independently stored page reports produced by one comparison call. */
  batchId?: string;
  /** Present for multi-page aware reports; legacy reports are treated as one page. */
  page?: { id: string; label: string; html: string; index: number; count: number };
  createdAt: string;
  design: { source: string; width: number; height: number; elementCount: number; designHash?: string; capture?: D2cCaptureDiagnostics };
  implementation: { source: string; width: number; height: number; elementCount: number; capture?: D2cCaptureDiagnostics };
  scores: D2cScores;
  evaluation: D2cEvaluation;
  diffs: D2cElementDiff[];
  missing: D2cUnmatchedElement[];
  extra: D2cUnmatchedElement[];
  pixelMismatchRate?: number;
}

export type D2cCaptureSource =
  | { kind: "file"; path: string }
  | { kind: "url"; url: string };

export interface CapturedPage {
  width: number;
  height: number;
  elements: D2cElementSnapshot[];
  screenshotPng: Buffer;
  diagnostics: D2cCaptureDiagnostics;
}

export interface D2cCaptureService {
  capture(
    source: D2cCaptureSource,
    viewport?: { width: number; height: number },
    signal?: AbortSignal,
  ): Promise<CapturedPage>;
}

export function rectArea(rect: D2cRect): number {
  return Math.max(0, rect.width) * Math.max(0, rect.height);
}
