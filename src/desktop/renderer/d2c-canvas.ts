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
