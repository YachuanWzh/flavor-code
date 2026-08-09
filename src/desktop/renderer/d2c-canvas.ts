import type { D2cRect } from "../../d2c/types.js";

export interface CanvasSize {
  width: number;
  height: number;
}

export interface CanvasPoint {
  x: number;
  y: number;
}

export interface CanvasTransform extends CanvasPoint {
  scale: number;
}

export interface D2cAxisMeasurement {
  axis: "x" | "y";
  /** Signed implementation offset relative to the design. */
  delta: number;
  label: string;
  start: CanvasPoint;
  end: CanvasPoint;
  designGuide: { start: CanvasPoint; end: CanvasPoint };
  implementationGuide: { start: CanvasPoint; end: CanvasPoint };
}

export const D2C_CANVAS_MIN_SCALE = 0.25;
export const D2C_CANVAS_MAX_SCALE = 4;

export function clampCanvasScale(scale: number): number {
  return Math.max(D2C_CANVAS_MIN_SCALE, Math.min(D2C_CANVAS_MAX_SCALE, scale));
}

export function fitCanvas(viewport: CanvasSize, canvas: CanvasSize, padding = 32): CanvasTransform {
  const availableWidth = Math.max(1, viewport.width - padding * 2);
  const availableHeight = Math.max(1, viewport.height - padding * 2);
  const scale = clampCanvasScale(Math.min(availableWidth / Math.max(1, canvas.width), availableHeight / Math.max(1, canvas.height)));
  return {
    scale,
    x: (viewport.width - canvas.width * scale) / 2,
    y: (viewport.height - canvas.height * scale) / 2,
  };
}

export function zoomCanvasAt(transform: CanvasTransform, nextScale: number, anchor: CanvasPoint): CanvasTransform {
  const scale = clampCanvasScale(nextScale);
  const ratio = scale / transform.scale;
  return {
    scale,
    x: anchor.x - (anchor.x - transform.x) * ratio,
    y: anchor.y - (anchor.y - transform.y) * ratio,
  };
}

export function focusCanvasRect(
  rect: D2cRect,
  viewport: CanvasSize,
  _canvas: CanvasSize,
  padding = 48,
): CanvasTransform {
  const availableWidth = Math.max(1, viewport.width - padding * 2);
  const availableHeight = Math.max(1, viewport.height - padding * 2);
  const scale = clampCanvasScale(Math.min(
    availableWidth / Math.max(1, rect.width),
    availableHeight / Math.max(1, rect.height),
  ));
  return {
    scale,
    x: viewport.width / 2 - (rect.x + rect.width / 2) * scale,
    y: viewport.height / 2 - (rect.y + rect.height / 2) * scale,
  };
}

function formatPixelDistance(value: number): string {
  const rounded = Math.round(Math.abs(value) * 10) / 10;
  return `${rounded} px`;
}

function rulerCoordinate(
  before: number,
  after: number,
  extent: number,
  scale: number,
): number {
  const offset = 18 / scale;
  const inset = 12 / scale;
  if (before - offset >= inset) return before - offset;
  if (after + offset <= extent - inset) return after + offset;
  return Math.max(inset, Math.min(extent - inset, before + offset));
}

/**
 * Builds orthogonal, Figma-style position measurements between matching
 * design and implementation rectangles. Values are based on their top-left
 * coordinates, which is the same definition used by D2cElementDiff.dx/dy.
 */
export function buildD2cAxisMeasurements(
  design: D2cRect,
  implementation: D2cRect,
  canvas: CanvasSize,
  scale = 1,
): D2cAxisMeasurement[] {
  const safeScale = Math.max(0.01, scale);
  const dx = implementation.x - design.x;
  const dy = implementation.y - design.y;
  const measurements: D2cAxisMeasurement[] = [];

  if (Math.abs(dx) >= 0.05) {
    const y = rulerCoordinate(
      Math.min(design.y, implementation.y),
      Math.max(design.y + design.height, implementation.y + implementation.height),
      canvas.height,
      safeScale,
    );
    const designAnchorY = y < design.y ? design.y : design.y + design.height;
    const implementationAnchorY = y < implementation.y
      ? implementation.y
      : implementation.y + implementation.height;
    measurements.push({
      axis: "x",
      delta: dx,
      label: formatPixelDistance(dx),
      start: { x: design.x, y },
      end: { x: implementation.x, y },
      designGuide: { start: { x: design.x, y: designAnchorY }, end: { x: design.x, y } },
      implementationGuide: {
        start: { x: implementation.x, y: implementationAnchorY },
        end: { x: implementation.x, y },
      },
    });
  }

  if (Math.abs(dy) >= 0.05) {
    const x = rulerCoordinate(
      Math.min(design.x, implementation.x),
      Math.max(design.x + design.width, implementation.x + implementation.width),
      canvas.width,
      safeScale,
    );
    const designAnchorX = x < design.x ? design.x : design.x + design.width;
    const implementationAnchorX = x < implementation.x
      ? implementation.x
      : implementation.x + implementation.width;
    measurements.push({
      axis: "y",
      delta: dy,
      label: formatPixelDistance(dy),
      start: { x, y: design.y },
      end: { x, y: implementation.y },
      designGuide: { start: { x: designAnchorX, y: design.y }, end: { x, y: design.y } },
      implementationGuide: {
        start: { x: implementationAnchorX, y: implementation.y },
        end: { x, y: implementation.y },
      },
    });
  }

  return measurements;
}
