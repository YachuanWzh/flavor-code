/**
 * Coordinate-level pointer control (independent of snapshot refs): move,
 * click, raw button down/up, drag with interpolated moves, and wheel scroll.
 * Coordinates are CSS pixels relative to the tab viewport — the same space
 * the in-page overlay visuals and browser bounds use.
 */

import type { SnapshotCommander } from "./snapshot-service.js";
import { BrowserError } from "./types.js";

export type MouseButtonName = "left" | "right" | "middle";
export type MouseOperation = "move" | "click" | "down" | "up" | "drag" | "wheel";

export interface MouseRequest {
  operation: MouseOperation;
  x: number;
  y: number;
  toX?: number;
  toY?: number;
  button?: MouseButtonName;
  /** For click: 1 or 2 (double). */
  clickCount?: number;
  deltaX?: number;
  deltaY?: number;
  /** Drag interpolation steps (2..30). */
  steps?: number;
}

const BUTTON_MASKS: Record<MouseButtonName, number> = { left: 1, right: 2, middle: 4 };

function requireCoordinate(value: number | undefined, name: string): number {
  if (value === undefined || !Number.isFinite(value) || value < 0) {
    throw new BrowserError("bad-input", `${name} must be a non-negative finite number`);
  }
  return Math.round(value);
}

interface MouseCommandOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export async function mouseViaCdp(
  commander: SnapshotCommander,
  request: MouseRequest,
  options: MouseCommandOptions = {},
): Promise<{ operation: MouseOperation; x: number; y: number }> {
  const command = options.signal === undefined ? { ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }) }
    : { ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }), signal: options.signal };
  const x = requireCoordinate(request.x, "x");
  const y = requireCoordinate(request.y, "y");
  const button = request.button ?? "left";
  const mask = BUTTON_MASKS[button];
  const move = (atX: number, atY: number, buttons = 0): Promise<unknown> => commander.sendCommand(
    "Input.dispatchMouseEvent",
    { type: "mouseMoved", x: atX, y: atY, ...(buttons === 0 ? {} : { buttons }) },
    command,
  );
  const press = (atX: number, atY: number, clickCount: number): Promise<unknown> => commander.sendCommand(
    "Input.dispatchMouseEvent",
    { type: "mousePressed", x: atX, y: atY, button, clickCount },
    command,
  );
  const release = (atX: number, atY: number, clickCount: number): Promise<unknown> => commander.sendCommand(
    "Input.dispatchMouseEvent",
    { type: "mouseReleased", x: atX, y: atY, button, clickCount },
    command,
  );

  switch (request.operation) {
    case "move": {
      await move(x, y);
      break;
    }
    case "click": {
      const count = Math.max(1, Math.min(2, request.clickCount ?? 1));
      await move(x, y);
      for (let cycle = 1; cycle <= count; cycle += 1) {
        await press(x, y, cycle);
        await release(x, y, cycle);
      }
      break;
    }
    case "down": {
      await move(x, y);
      await press(x, y, 1);
      break;
    }
    case "up": {
      await release(x, y, 1);
      break;
    }
    case "drag": {
      const toX = requireCoordinate(request.toX, "toX");
      const toY = requireCoordinate(request.toY, "toY");
      const steps = Math.max(2, Math.min(30, request.steps ?? 12));
      await move(x, y);
      await press(x, y, 1);
      for (let step = 1; step <= steps; step += 1) {
        const ratio = step / steps;
        await move(Math.round(x + (toX - x) * ratio), Math.round(y + (toY - y) * ratio), mask);
      }
      await release(toX, toY, 1);
      break;
    }
    case "wheel": {
      const deltaX = Math.round(request.deltaX ?? 0);
      const deltaY = Math.round(request.deltaY ?? 0);
      if (deltaX === 0 && deltaY === 0) {
        throw new BrowserError("bad-input", "wheel needs a non-zero deltaX or deltaY");
      }
      await move(x, y);
      await commander.sendCommand(
        "Input.dispatchMouseEvent",
        { type: "mouseWheel", x, y, deltaX, deltaY },
        command,
      );
      break;
    }
  }
  return { operation: request.operation, x, y };
}

export function pointerLabel(request: MouseRequest): string {
  const x = Math.round(request.x);
  const y = Math.round(request.y);
  switch (request.operation) {
    case "move": return `移动鼠标 → (${x}, ${y})`;
    case "click": return request.clickCount === 2 ? `双击 (${x}, ${y})` : `点击 (${x}, ${y})`;
    case "down": return `按下${request.button === "right" ? "右键" : "左键"} (${x}, ${y})`;
    case "up": return `松开 (${x}, ${y})`;
    case "drag": return `拖拽 (${x}, ${y}) → (${Math.round(request.toX ?? x)}, ${Math.round(request.toY ?? y)})`;
    case "wheel": {
      const deltaY = Math.round(request.deltaY ?? 0);
      return deltaY <= 0 ? `滚轮向上 ${Math.abs(deltaY)}` : `滚轮向下 ${deltaY}`;
    }
  }
}
