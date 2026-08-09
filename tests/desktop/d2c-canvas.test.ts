import { describe, expect, it } from "vitest";

import { clampCanvasScale, fitCanvas, focusCanvasRect, zoomCanvasAt } from "../../src/desktop/renderer/d2c-canvas.js";

describe("D2C canvas geometry", () => {
  it("fits a canvas inside the viewport with breathing room", () => {
    expect(fitCanvas({ width: 1000, height: 700 }, { width: 1280, height: 800 }, 32)).toEqual({
      scale: 0.73125,
      x: 32,
      y: 57.5,
    });
  });

  it("keeps the pointer anchored while zooming", () => {
    expect(zoomCanvasAt({ scale: 1, x: 20, y: 30 }, 2, { x: 120, y: 130 })).toEqual({ scale: 2, x: -80, y: -70 });
  });

  it("focuses a problem region without exceeding zoom limits", () => {
    const focused = focusCanvasRect(
      { x: 900, y: 600, width: 100, height: 50 },
      { width: 800, height: 600 },
      { width: 1280, height: 800 },
    );
    expect(focused.scale).toBeGreaterThan(1);
    expect(focused.scale).toBeLessThanOrEqual(4);
    expect(900 * focused.scale + focused.x).toBeGreaterThan(0);
  });

  it("clamps zoom to the product limits", () => {
    expect(clampCanvasScale(0.01)).toBe(0.25);
    expect(clampCanvasScale(10)).toBe(4);
  });
});
