import { describe, expect, it } from "vitest";

import { buildD2cAxisMeasurements, clampCanvasScale, fitCanvas, focusCanvasRect, zoomCanvasAt } from "../../src/desktop/renderer/d2c-canvas.js";

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

  it("builds horizontal and vertical pixel rulers from design to implementation", () => {
    const measurements = buildD2cAxisMeasurements(
      { x: 100, y: 80, width: 120, height: 48 },
      { x: 112, y: 104, width: 120, height: 48 },
      { width: 800, height: 600 },
    );

    expect(measurements).toHaveLength(2);
    expect(measurements[0]).toMatchObject({
      axis: "x", delta: 12, label: "12 px",
      start: { x: 100 }, end: { x: 112 },
    });
    expect(measurements[1]).toMatchObject({
      axis: "y", delta: 24, label: "24 px",
      start: { y: 80 }, end: { y: 104 },
    });
  });

  it("omits zero-offset axes and keeps fractional pixel distances", () => {
    const measurements = buildD2cAxisMeasurements(
      { x: 10, y: 10, width: 40, height: 20 },
      { x: 10, y: 7.25, width: 44, height: 20 },
      { width: 100, height: 100 },
    );

    expect(measurements).toHaveLength(1);
    expect(measurements[0]).toMatchObject({ axis: "y", delta: -2.75, label: "2.8 px" });
  });
});
