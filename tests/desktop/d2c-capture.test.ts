import { describe, expect, it } from "vitest";

import {
  D2C_CAPTURE_PREPARATION_SCRIPT,
  fitCaptureSize,
  isAllowedCaptureNavigation,
} from "../../src/desktop/d2c-capture.js";

describe("D2C capture helpers", () => {
  it("waits for fonts and images and disables motion before capture", () => {
    expect(D2C_CAPTURE_PREPARATION_SCRIPT).toContain("document.fonts.ready");
    expect(D2C_CAPTURE_PREPARATION_SCRIPT).toContain("decode()");
    expect(D2C_CAPTURE_PREPARATION_SCRIPT).toContain("animation");
    expect(D2C_CAPTURE_PREPARATION_SCRIPT).toContain("transition");
  });

  it("fits long pages within the pixel budget while retaining content", () => {
    expect(fitCaptureSize(1280, 2400)).toEqual({ width: 1280, height: 2400 });
    const fitted = fitCaptureSize(8192, 8192);
    expect(fitted.width * fitted.height).toBeLessThanOrEqual(8_388_608);
    expect(fitted.width / fitted.height).toBeCloseTo(1, 2);
  });

  it("allows only the original file or localhost origin to navigate", () => {
    const file = "file:///C:/design/index.html";
    expect(isAllowedCaptureNavigation(file, `${file}#hero`)).toBe(true);
    expect(isAllowedCaptureNavigation(file, "file:///C:/secrets.txt")).toBe(false);
    expect(isAllowedCaptureNavigation("http://localhost:5173/", "http://localhost:5173/about")).toBe(true);
    expect(isAllowedCaptureNavigation("http://localhost:5173/", "https://example.com/")).toBe(false);
  });
});
