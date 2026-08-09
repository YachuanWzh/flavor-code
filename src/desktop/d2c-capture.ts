import { pathToFileURL } from "node:url";

import { BrowserWindow } from "electron";

import type { CapturedPage, D2cCaptureService, D2cCaptureSource, D2cElementSnapshot } from "../d2c/types.js";

const DEFAULT_VIEWPORT = { width: 1280, height: 800 };
/** Extra settle time after load so fonts and images finish rendering. */
const SETTLE_MS = 250;
const MAX_ELEMENTS = 500;

// Collects visible, styled elements for the DOM-level diff. Runs inside the
// hidden capture window, so it must be self-contained and side-effect free.
const COLLECT_SCRIPT = `(() => {
  const directText = (element) => Array.from(element.childNodes)
    .filter((node) => node.nodeType === 3)
    .map((node) => node.textContent.trim())
    .filter(Boolean)
    .join(" ");
  const elements = [];
  let id = 0;
  for (const element of document.body.querySelectorAll("*")) {
    if (elements.length >= ${MAX_ELEMENTS}) break;
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;
    const style = getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden") continue;
    const tag = element.tagName.toLowerCase();
    const text = directText(element);
    const hasImage = tag === "img" || tag === "svg" || style.backgroundImage !== "none";
    if (text === "" && !hasImage && style.backgroundColor === "rgba(0, 0, 0, 0)") continue;
    elements.push({
      id: id++,
      tag,
      text,
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      styles: {
        color: style.color,
        backgroundColor: style.backgroundColor,
        fontSize: parseFloat(style.fontSize),
        fontWeight: style.fontWeight,
        fontFamily: style.fontFamily,
      },
      hasImage,
    });
  }
  return {
    width: document.documentElement.clientWidth,
    height: document.documentElement.clientHeight,
    elements,
  };
})()`;

interface RawSnapshot {
  width: unknown;
  height: unknown;
  elements: unknown;
}

function finiteNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Validates the shape returned by the injected collection script. */
function sanitizeSnapshot(raw: RawSnapshot): { width: number; height: number; elements: D2cElementSnapshot[] } {
  const elements: D2cElementSnapshot[] = [];
  if (Array.isArray(raw.elements)) {
    for (const item of raw.elements) {
      if (typeof item !== "object" || item === null) continue;
      const entry = item as Record<string, unknown>;
      const rect = (typeof entry.rect === "object" && entry.rect !== null ? entry.rect : {}) as Record<string, unknown>;
      const styles = (typeof entry.styles === "object" && entry.styles !== null ? entry.styles : {}) as Record<string, unknown>;
      elements.push({
        id: elements.length,
        tag: typeof entry.tag === "string" ? entry.tag : "div",
        text: typeof entry.text === "string" ? entry.text : "",
        rect: {
          x: finiteNumber(rect.x),
          y: finiteNumber(rect.y),
          width: finiteNumber(rect.width),
          height: finiteNumber(rect.height),
        },
        styles: {
          ...(typeof styles.color === "string" ? { color: styles.color } : {}),
          ...(typeof styles.backgroundColor === "string" ? { backgroundColor: styles.backgroundColor } : {}),
          ...(Number.isFinite(styles.fontSize) ? { fontSize: styles.fontSize as number } : {}),
          ...(typeof styles.fontWeight === "string" ? { fontWeight: styles.fontWeight } : {}),
          ...(typeof styles.fontFamily === "string" ? { fontFamily: styles.fontFamily } : {}),
        },
        hasImage: entry.hasImage === true,
      });
    }
  }
  return { width: finiteNumber(raw.width), height: finiteNumber(raw.height), elements };
}

/**
 * Renders pages in a hidden, sandboxed BrowserWindow and captures both a DOM
 * snapshot and a screenshot. Only the desktop app can construct one, which is
 * why D2C comparison is desktop-only.
 */
export function createD2cCaptureService(): D2cCaptureService {
  return {
    async capture(source: D2cCaptureSource, viewport?: { width: number; height: number }): Promise<CapturedPage> {
      const size = viewport ?? DEFAULT_VIEWPORT;
      const window = new BrowserWindow({
        show: false,
        width: size.width,
        height: size.height,
        webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
      });
      try {
        const url = source.kind === "file" ? pathToFileURL(source.path).toString() : source.url;
        await window.loadURL(url);
        // Wait two frames plus a settle delay so async layout and fonts finish.
        await window.webContents.executeJavaScript(
          "new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
        );
        await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
        const raw = await window.webContents.executeJavaScript(COLLECT_SCRIPT) as RawSnapshot;
        const snapshot = sanitizeSnapshot(raw);
        const page = await window.webContents.capturePage();
        return { ...snapshot, screenshotPng: Buffer.from(page.toPNG()) };
      } finally {
        window.destroy();
      }
    },
  };
}
