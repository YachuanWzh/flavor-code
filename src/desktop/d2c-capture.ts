import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

import { BrowserWindow, type DownloadItem, type Event } from "electron";

import { D2C_MAX_PIXELS } from "../d2c/pixel.js";
import type { CapturedPage, D2cCaptureService, D2cCaptureSource, D2cElementSnapshot } from "../d2c/types.js";

const DEFAULT_VIEWPORT = { width: 1280, height: 800 };
const MAX_CAPTURE_DIMENSION = 4096;
const LOAD_TIMEOUT_MS = 30_000;
const MAX_ELEMENTS = 2_000;

export function fitCaptureSize(width: number, height: number): { width: number; height: number } {
  const safeWidth = Number.isFinite(width) && width > 0 ? width : 1;
  const safeHeight = Number.isFinite(height) && height > 0 ? height : 1;
  let scale = Math.min(1, MAX_CAPTURE_DIMENSION / Math.max(safeWidth, safeHeight));
  if (safeWidth * safeHeight * scale * scale > D2C_MAX_PIXELS) {
    scale = Math.min(scale, Math.sqrt(D2C_MAX_PIXELS / (safeWidth * safeHeight)));
  }
  return {
    width: Math.max(1, Math.floor(safeWidth * scale)),
    height: Math.max(1, Math.floor(safeHeight * scale)),
  };
}

export function isAllowedCaptureNavigation(initialUrl: string, targetUrl: string): boolean {
  try {
    const initial = new URL(initialUrl);
    const target = new URL(targetUrl);
    if (initial.protocol === "file:") {
      initial.hash = "";
      target.hash = "";
      return target.protocol === "file:" && target.toString() === initial.toString();
    }
    return (initial.hostname === "localhost" || initial.hostname === "127.0.0.1" || initial.hostname === "[::1]")
      && target.origin === initial.origin;
  } catch {
    return false;
  }
}

export const D2C_CAPTURE_PREPARATION_SCRIPT = `(() => {
  const style = document.createElement("style");
  style.dataset.d2cCapture = "true";
  style.textContent = "*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}";
  document.documentElement.appendChild(style);
  const fonts = document.fonts ? document.fonts.ready : Promise.resolve();
  const images = Array.from(document.images).map((image) => image.complete
    ? (typeof image.decode === "function" ? image.decode().catch(() => undefined) : Promise.resolve())
    : new Promise((resolve) => { image.addEventListener("load", resolve, { once: true }); image.addEventListener("error", resolve, { once: true }); }));
  return Promise.all([fonts, ...images]).then(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
})()`;

const MEASURE_SCRIPT = `(() => ({
  width: Math.max(document.documentElement.scrollWidth, document.body?.scrollWidth ?? 0, window.innerWidth),
  height: Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0, window.innerHeight),
}))()`;

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
    if (rect.width * rect.height < 16 || rect.right <= 0 || rect.bottom <= 0
      || rect.left >= window.innerWidth || rect.top >= window.innerHeight) continue;
    const style = getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden") continue;
    const tag = element.tagName.toLowerCase();
    const text = directText(element);
    const hasImage = tag === "img" || tag === "svg" || style.backgroundImage !== "none";
    const hasBorder = parseFloat(style.borderTopWidth) > 0 || parseFloat(style.borderRightWidth) > 0
      || parseFloat(style.borderBottomWidth) > 0 || parseFloat(style.borderLeftWidth) > 0;
    if (text === "" && !hasImage && !hasBorder && style.backgroundColor === "rgba(0, 0, 0, 0)") continue;
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
    width: window.innerWidth,
    height: window.innerHeight,
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

function awaitWithSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise((resolvePromise, rejectPromise) => {
    const onAbort = (): void => rejectPromise(signal.reason ?? new Error("D2C capture cancelled"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => { signal.removeEventListener("abort", onAbort); resolvePromise(value); },
      (error: unknown) => { signal.removeEventListener("abort", onAbort); rejectPromise(error); },
    );
  });
}

/**
 * Renders pages in a hidden, sandboxed BrowserWindow and captures both a DOM
 * snapshot and a screenshot. Only the desktop app can construct one, which is
 * why D2C comparison is desktop-only.
 */
export function createD2cCaptureService(): D2cCaptureService {
  return {
    async capture(
      source: D2cCaptureSource,
      viewport?: { width: number; height: number },
      signal?: AbortSignal,
    ): Promise<CapturedPage> {
      signal?.throwIfAborted();
      const requested = fitCaptureSize(viewport?.width ?? DEFAULT_VIEWPORT.width, viewport?.height ?? DEFAULT_VIEWPORT.height);
      const url = source.kind === "file" ? pathToFileURL(source.path).toString() : source.url;
      if (source.kind === "url") {
        const parsed = new URL(url);
        if (!(["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname))
          || !(["http:", "https:"].includes(parsed.protocol))) {
          throw new Error(`D2C capture only supports localhost URLs: ${url}`);
        }
      }
      const window = new BrowserWindow({
        show: false,
        frame: false,
        useContentSize: true,
        width: requested.width,
        height: requested.height,
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
          partition: `d2c-capture-${randomUUID()}`,
        },
      });
      window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      const guardNavigation = (event: Event, target: string): void => {
        if (!isAllowedCaptureNavigation(url, target)) event.preventDefault();
      };
      window.webContents.on("will-navigate", guardNavigation);
      window.webContents.on("will-redirect", guardNavigation);
      window.webContents.on("will-attach-webview", (event) => event.preventDefault());
      const preventDownload = (event: Event, item: DownloadItem): void => {
        event.preventDefault();
        item.cancel();
      };
      const captureSession = window.webContents.session;
      captureSession.on("will-download", preventDownload);
      const timeoutSignal = AbortSignal.timeout(LOAD_TIMEOUT_MS);
      const captureSignal = signal === undefined ? timeoutSignal : AbortSignal.any([signal, timeoutSignal]);
      const destroyOnAbort = (): void => { if (!window.isDestroyed()) window.destroy(); };
      captureSignal.addEventListener("abort", destroyOnAbort, { once: true });
      try {
        await awaitWithSignal(window.loadURL(url), captureSignal);
        await awaitWithSignal(window.webContents.executeJavaScript(D2C_CAPTURE_PREPARATION_SCRIPT), captureSignal);
        if (viewport === undefined) {
          const measured = await awaitWithSignal(
            window.webContents.executeJavaScript(MEASURE_SCRIPT) as Promise<{ width: number; height: number }>,
            captureSignal,
          );
          const natural = fitCaptureSize(finiteNumber(measured.width), finiteNumber(measured.height));
          if (natural.width !== requested.width || natural.height !== requested.height) {
            window.setContentSize(natural.width, natural.height);
            await awaitWithSignal(window.webContents.executeJavaScript(D2C_CAPTURE_PREPARATION_SCRIPT), captureSignal);
          }
        }
        const raw = await window.webContents.executeJavaScript(COLLECT_SCRIPT) as RawSnapshot;
        const snapshot = sanitizeSnapshot(raw);
        const page = await window.webContents.capturePage();
        return { ...snapshot, screenshotPng: Buffer.from(page.toPNG()) };
      } finally {
        captureSignal.removeEventListener("abort", destroyOnAbort);
        captureSession.removeListener("will-download", preventDownload);
        if (!window.isDestroyed()) window.destroy();
      }
    },
  };
}
