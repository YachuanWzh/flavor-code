import { describe, expect, it } from "vitest";
import { PNG } from "pngjs";

import {
  D2C_CAPTURE_DIAGNOSTICS_SCRIPT,
  D2C_CAPTURE_PREPARATION_SCRIPT,
  D2C_RENDER_HEALTH_SCRIPT,
  captureTileOffsets,
  fitCaptureSize,
  formatD2cRenderFailure,
  isAllowedCaptureNavigation,
  stitchCaptureTiles,
} from "../../src/desktop/d2c-capture.js";

function solidPng(width: number, height: number, color: readonly [number, number, number, number]): Buffer {
  const image = new PNG({ width, height });
  for (let index = 0; index < image.data.length; index += 4) image.data.set(color, index);
  return PNG.sync.write(image);
}

describe("D2C capture helpers", () => {
  it("waits for fonts and images and disables motion before capture", () => {
    expect(D2C_CAPTURE_PREPARATION_SCRIPT).toContain("document.fonts.ready");
    expect(D2C_CAPTURE_PREPARATION_SCRIPT).toContain("decode()");
    expect(D2C_CAPTURE_PREPARATION_SCRIPT).toContain("animation");
    expect(D2C_CAPTURE_PREPARATION_SCRIPT).toContain("transition");
    expect(D2C_CAPTURE_PREPARATION_SCRIPT).toContain("::-webkit-scrollbar");
    expect(D2C_CAPTURE_PREPARATION_SCRIPT).toContain("scrollbar-width:none");
  });

  it("records the diagnostics needed to judge whether a comparison is trustworthy", () => {
    expect(D2C_CAPTURE_DIAGNOSTICS_SCRIPT).toContain("devicePixelRatio");
    expect(D2C_CAPTURE_DIAGNOSTICS_SCRIPT).toContain("fontsReady");
    expect(D2C_CAPTURE_DIAGNOSTICS_SCRIPT).toContain("failedImages");
    expect(D2C_CAPTURE_DIAGNOSTICS_SCRIPT).toContain("clipped");
  });

  it("detects development-server error overlays before collecting or screenshotting", () => {
    expect(D2C_RENDER_HEALTH_SCRIPT).toContain('querySelector("vite-error-overlay")');
    expect(D2C_RENDER_HEALTH_SCRIPT).toContain("shadowRoot");
    expect(D2C_RENDER_HEALTH_SCRIPT).toContain("webpack-dev-server-client-overlay");
    expect(formatD2cRenderFailure({
      kind: "Vite compilation error",
      message: '[plugin:vite:import-analysis] Failed to resolve import "./styles.css"',
    })).toContain('Failed to resolve import "./styles.css"');
    expect(formatD2cRenderFailure(null)).toBeUndefined();
  });

  it("ships syntactically valid renderer scripts", () => {
    for (const script of [
      D2C_CAPTURE_PREPARATION_SCRIPT,
      D2C_CAPTURE_DIAGNOSTICS_SCRIPT,
      D2C_RENDER_HEALTH_SCRIPT,
    ]) {
      expect(() => new Function(script)).not.toThrow();
    }
    expect(D2C_RENDER_HEALTH_SCRIPT).toContain('join("\\n")');
  });

  it("uses native window resizing and capturePage for long pages", async () => {
    const source = await import("node:fs/promises").then(({ readFile }) =>
      readFile(new URL("../../src/desktop/d2c-capture.ts", import.meta.url), "utf8"));
    expect(source).toContain("window.setContentSize");
    expect(source).toContain("window.webContents.capturePage");
    expect(source).not.toContain("webContents.debugger");
    expect(source).not.toContain("Page.captureScreenshot");
  });

  it("loads the page before resizing and capturing it", async () => {
    const source = await import("node:fs/promises").then(({ readFile }) =>
      readFile(new URL("../../src/desktop/d2c-capture.ts", import.meta.url), "utf8"));
    const service = source.slice(source.indexOf("export function createD2cCaptureService"));
    const loadPage = service.indexOf("await awaitWithSignal(window.loadURL(url), captureSignal)");
    const resizeWindow = service.indexOf("window.setContentSize");
    const renderHealth = service.indexOf("D2C_RENDER_HEALTH_SCRIPT");
    const capturePage = service.indexOf("await captureFullPage");
    expect(loadPage).toBeGreaterThan(-1);
    expect(loadPage).toBeLessThan(resizeWindow);
    expect(resizeWindow).toBeLessThan(renderHealth);
    expect(renderHealth).toBeLessThan(capturePage);
    expect(resizeWindow).toBeLessThan(capturePage);
  });

  it("covers a long page with non-duplicated viewport offsets", () => {
    expect(captureTileOffsets(2420, 1032)).toEqual([0, 1032, 1388]);
    expect(captureTileOffsets(800, 1032)).toEqual([0]);
    expect(captureTileOffsets(2064, 1032)).toEqual([0, 1032]);
  });

  it("stitches captured viewport tiles into one full-page PNG", () => {
    const result = PNG.sync.read(stitchCaptureTiles([
      { x: 0, y: 0, png: solidPng(2, 2, [255, 0, 0, 255]) },
      { x: 0, y: 2, png: solidPng(2, 2, [0, 0, 255, 255]) },
    ], 2, 4));
    expect({ width: result.width, height: result.height }).toEqual({ width: 2, height: 4 });
    expect([...result.data.subarray(0, 4)]).toEqual([255, 0, 0, 255]);
    expect([...result.data.subarray((3 * 2) * 4, (3 * 2) * 4 + 4)]).toEqual([0, 0, 255, 255]);
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
