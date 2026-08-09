import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

import { BrowserWindow, type DownloadItem, type Event } from "electron";
import { PNG } from "pngjs";

import { D2C_MAX_PIXELS } from "../d2c/pixel.js";
import type {
  CapturedPage,
  D2cCaptureDiagnostics,
  D2cCaptureService,
  D2cCaptureSource,
  D2cElementSnapshot,
} from "../d2c/types.js";

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

export function captureTileOffsets(pageLength: number, viewportLength: number): number[] {
  const page = Math.max(1, Math.floor(pageLength));
  const viewport = Math.max(1, Math.floor(viewportLength));
  if (viewport >= page) return [0];
  const last = page - viewport;
  const offsets: number[] = [];
  for (let offset = 0; offset < last; offset += viewport) offsets.push(offset);
  if (offsets.at(-1) !== last) offsets.push(last);
  return offsets;
}

export interface D2cCaptureTile {
  x: number;
  y: number;
  png: Buffer;
}

export function stitchCaptureTiles(tiles: readonly D2cCaptureTile[], width: number, height: number): Buffer {
  const targetWidth = Math.max(1, Math.floor(width));
  const targetHeight = Math.max(1, Math.floor(height));
  const output = new PNG({ width: targetWidth, height: targetHeight });
  for (const tile of tiles) {
    const image = PNG.sync.read(tile.png);
    const x = Math.max(0, Math.floor(tile.x));
    const y = Math.max(0, Math.floor(tile.y));
    const copyWidth = Math.min(image.width, targetWidth - x);
    const copyHeight = Math.min(image.height, targetHeight - y);
    if (copyWidth <= 0 || copyHeight <= 0) continue;
    for (let row = 0; row < copyHeight; row += 1) {
      const sourceStart = row * image.width * 4;
      const targetStart = ((y + row) * targetWidth + x) * 4;
      image.data.copy(output.data, targetStart, sourceStart, sourceStart + copyWidth * 4);
    }
  }
  return PNG.sync.write(output);
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
  style.textContent = "*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}html{scrollbar-width:none!important}body{-ms-overflow-style:none!important}*::-webkit-scrollbar{display:none!important;width:0!important;height:0!important}";
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

export const D2C_CAPTURE_DIAGNOSTICS_SCRIPT = `(() => {
  const naturalWidth = Math.max(document.documentElement.scrollWidth, document.body?.scrollWidth ?? 0, window.innerWidth);
  const naturalHeight = Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0, window.innerHeight);
  const images = Array.from(document.images);
  return {
    devicePixelRatio: window.devicePixelRatio,
    fontsReady: !document.fonts || document.fonts.status === "loaded",
    imageCount: images.length,
    failedImages: images.filter((image) => !image.complete || image.naturalWidth === 0).length,
    naturalWidth,
    naturalHeight,
    clipped: naturalWidth > window.innerWidth + 1 || naturalHeight > window.innerHeight + 1,
  };
})()`;

// Collects visible, styled elements for the DOM-level diff. Runs inside the
// hidden capture window, so it must be self-contained and side-effect free.
const COLLECT_SCRIPT = `(() => {
  const directText = (element) => Array.from(element.childNodes)
    .filter((node) => node.nodeType === 3)
    .map((node) => node.textContent.trim())
    .filter(Boolean)
    .join(" ");
  const selectorFor = (element) => {
    if (element.id) return "#" + CSS.escape(element.id);
    const parts = [];
    let current = element;
    while (current && current !== document.body && parts.length < 5) {
      const tag = current.tagName.toLowerCase();
      const siblings = current.parentElement
        ? Array.from(current.parentElement.children).filter((sibling) => sibling.tagName === current.tagName)
        : [];
      const position = siblings.length > 1 ? ":nth-of-type(" + (siblings.indexOf(current) + 1) + ")" : "";
      parts.unshift(tag + position);
      current = current.parentElement;
    }
    return parts.join(" > ");
  };
  const elements = [];
  const pageWidth = Math.max(document.documentElement.scrollWidth, document.body?.scrollWidth ?? 0, window.innerWidth);
  const pageHeight = Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0, window.innerHeight);
  let id = 0;
  for (const element of document.body.querySelectorAll("*")) {
    if (elements.length >= ${MAX_ELEMENTS}) break;
    const rect = element.getBoundingClientRect();
    const x = rect.x + window.scrollX;
    const y = rect.y + window.scrollY;
    if (rect.width * rect.height < 16 || x + rect.width <= 0 || y + rect.height <= 0
      || x >= pageWidth || y >= pageHeight) continue;
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
      rect: { x, y, width: rect.width, height: rect.height },
      styles: {
        color: style.color,
        backgroundColor: style.backgroundColor,
        fontSize: parseFloat(style.fontSize),
        fontWeight: style.fontWeight,
        fontFamily: style.fontFamily,
      },
      hasImage,
      selector: selectorFor(element),
    });
  }
  return {
    width: pageWidth,
    height: pageHeight,
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
        ...(typeof entry.selector === "string" && entry.selector.length <= 512 ? { selector: entry.selector } : {}),
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

async function captureFullPage(
  window: BrowserWindow,
  width: number,
  height: number,
  signal: AbortSignal,
): Promise<Buffer> {
  const viewport = await awaitWithSignal(window.webContents.executeJavaScript(`(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
  }))()`) as Promise<{ width: number; height: number }>, signal);
  const viewportWidth = Math.max(1, Math.floor(finiteNumber(viewport.width)));
  const viewportHeight = Math.max(1, Math.floor(finiteNumber(viewport.height)));
  const tiles: D2cCaptureTile[] = [];
  const captured = new Set<string>();
  try {
    for (const y of captureTileOffsets(height, viewportHeight)) {
      for (const x of captureTileOffsets(width, viewportWidth)) {
        signal.throwIfAborted();
        const position = await awaitWithSignal(window.webContents.executeJavaScript(`new Promise((resolve) => {
          window.scrollTo(${x}, ${y});
          requestAnimationFrame(() => requestAnimationFrame(() => resolve({ x: window.scrollX, y: window.scrollY })));
        })`) as Promise<{ x: number; y: number }>, signal);
        const tileX = Math.max(0, Math.floor(finiteNumber(position.x)));
        const tileY = Math.max(0, Math.floor(finiteNumber(position.y)));
        const key = `${tileX}:${tileY}`;
        if (captured.has(key)) continue;
        captured.add(key);
        let image = await awaitWithSignal(window.webContents.capturePage(), signal);
        const size = image.getSize();
        if (size.width !== viewportWidth || size.height !== viewportHeight) {
          image = image.resize({ width: viewportWidth, height: viewportHeight, quality: "best" });
        }
        tiles.push({ x: tileX, y: tileY, png: Buffer.from(image.toPNG()) });
      }
    }
  } finally {
    if (!window.isDestroyed()) {
      await window.webContents.executeJavaScript("window.scrollTo(0, 0)").catch(() => undefined);
    }
  }
  return stitchCaptureTiles(tiles, width, height);
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
        let captureSize = requested;
        for (let attempt = 0; attempt < 2; attempt += 1) {
          await awaitWithSignal(window.webContents.executeJavaScript(D2C_CAPTURE_PREPARATION_SCRIPT), captureSignal);
          const measured = await awaitWithSignal(
            window.webContents.executeJavaScript(MEASURE_SCRIPT) as Promise<{ width: number; height: number }>,
            captureSignal,
          );
          const next = fitCaptureSize(
            Math.max(requested.width, finiteNumber(measured.width)),
            Math.max(requested.height, finiteNumber(measured.height)),
          );
          if (next.width === captureSize.width && next.height === captureSize.height) break;
          captureSize = next;
          window.setContentSize(captureSize.width, captureSize.height);
        }
        await awaitWithSignal(window.webContents.executeJavaScript(D2C_CAPTURE_PREPARATION_SCRIPT), captureSignal);
        const raw = await awaitWithSignal(window.webContents.executeJavaScript(COLLECT_SCRIPT) as Promise<RawSnapshot>, captureSignal);
        const collected = sanitizeSnapshot(raw);
        const snapshot = { ...collected, width: captureSize.width, height: captureSize.height };
        const rawDiagnostics = await awaitWithSignal(
          window.webContents.executeJavaScript(D2C_CAPTURE_DIAGNOSTICS_SCRIPT) as Promise<Partial<D2cCaptureDiagnostics>>,
          captureSignal,
        );
        const naturalWidth = finiteNumber(rawDiagnostics.naturalWidth);
        const naturalHeight = finiteNumber(rawDiagnostics.naturalHeight);
        const diagnostics: D2cCaptureDiagnostics = {
          devicePixelRatio: finiteNumber(rawDiagnostics.devicePixelRatio) || 1,
          fontsReady: rawDiagnostics.fontsReady === true,
          imageCount: Math.max(0, Math.round(finiteNumber(rawDiagnostics.imageCount))),
          failedImages: Math.max(0, Math.round(finiteNumber(rawDiagnostics.failedImages))),
          naturalWidth,
          naturalHeight,
          clipped: naturalWidth > captureSize.width + 1 || naturalHeight > captureSize.height + 1,
        };
        const screenshotPng = await captureFullPage(window, captureSize.width, captureSize.height, captureSignal);
        return { ...snapshot, screenshotPng, diagnostics };
      } finally {
        captureSignal.removeEventListener("abort", destroyOnAbort);
        captureSession.removeListener("will-download", preventDownload);
        if (!window.isDestroyed()) window.destroy();
      }
    },
  };
}
