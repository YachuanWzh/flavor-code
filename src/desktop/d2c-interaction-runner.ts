import { randomUUID } from "node:crypto";

import { BrowserWindow } from "electron";

import {
  isLoopbackPreviewUrl,
  runInteractionManifest,
  type D2cInteractionActionStep,
  type D2cInteractionExpectStep,
  type D2cInteractionManifest,
  type D2cInteractionRun,
} from "../d2c/interaction.js";

const ASSERTION_TIMEOUT_MS = 3_000;
const MAX_DIAGNOSTIC_ENTRIES = 8;

function actionScript(step: D2cInteractionActionStep): string {
  const encoded = JSON.stringify(step);
  return `(() => { const step = ${encoded}; const fail = (message) => { throw new Error(message); };
    if (step.action === "key") { const event = new KeyboardEvent("keydown", { key: step.value, bubbles: true, cancelable: true }); document.dispatchEvent(event); return; }
    const element = document.querySelector(step.selector); if (!element) fail("Interaction element not found: " + step.selector);
    if (step.action === "click") { element.click(); return; }
    if (step.action === "hover") { element.dispatchEvent(new MouseEvent("mouseenter", { bubbles: false })); element.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })); element.focus?.(); return; }
    if (step.action === "fill") { const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), "value")?.set; setter ? setter.call(element, step.value) : element.value = step.value; element.dispatchEvent(new Event("input", { bubbles: true })); element.dispatchEvent(new Event("change", { bubbles: true })); }
  })()`;
}

function assertionScript(step: D2cInteractionExpectStep): string {
  const encoded = JSON.stringify(step);
  return `(() => { const step = ${encoded}; const elements = [...document.querySelectorAll(step.selector)]; const element = elements[0];
    if (step.expect === "count") return { passed: elements.length === step.value, actual: String(elements.length) };
    if (!element) return { passed: false, actual: "element missing" };
    if (step.expect === "visible") { const style = getComputedStyle(element); const rect = element.getBoundingClientRect(); const visible = !element.hidden && style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0; return { passed: visible, actual: String(visible) }; }
    if (step.expect === "attribute") { const actual = element.getAttribute(step.name); return { passed: actual === step.value, actual: String(actual) }; }
    if (step.expect === "class") return { passed: element.classList.contains(step.value), actual: element.className };
    const actual = (element.textContent || "").trim(); return { passed: step.expect === "text" ? actual === step.value : actual.includes(step.value), actual };
  })()`;
}

async function pollAssertion(window: BrowserWindow, step: D2cInteractionExpectStep): Promise<{ passed: boolean; actual?: string }> {
  const deadline = Date.now() + ASSERTION_TIMEOUT_MS;
  let last: { passed: boolean; actual?: string } = { passed: false };
  while (Date.now() <= deadline) {
    last = await window.webContents.executeJavaScript(assertionScript(step), true) as { passed: boolean; actual?: string };
    if (last.passed) return last;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
  return last;
}

export async function runElectronD2cInteractionTests(manifest: D2cInteractionManifest, baseUrl: string, mockUrl: string): Promise<D2cInteractionRun> {
  if (!isLoopbackPreviewUrl(baseUrl)) throw new Error("D2C interaction preview must use loopback HTTP");
  if (!isLoopbackPreviewUrl(mockUrl)) throw new Error("D2C interaction mock must use loopback HTTP");
  const origin = new URL(baseUrl).origin;
  const mockOrigin = new URL(mockUrl).origin;
  return runInteractionManifest(manifest, baseUrl, async () => {
    const window = new BrowserWindow({
      show: false, width: 1440, height: 1000,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true,
        partition: `d2c-interaction-${randomUUID()}` },
    });
    let requests = 0;
    let networkErrors: string[] = [];
    let consoleErrors: string[] = [];
    const noteNetworkError = (entry: string): void => {
      if (networkErrors.length < MAX_DIAGNOSTIC_ENTRIES && !networkErrors.includes(entry)) networkErrors.push(entry);
    };
    window.webContents.session.webRequest.onCompleted({ urls: ["http://127.0.0.1:*/*", "http://localhost:*/*"] }, (details) => {
      // Electron classifies both XMLHttpRequest and Fetch API traffic as `xhr` here.
      if (details.resourceType === "xhr" && details.statusCode < 500 && new URL(details.url).origin === mockOrigin) requests += 1;
      if (details.resourceType === "xhr" && details.error !== "net::OK") noteNetworkError(`${details.method} ${details.url} failed (${details.error})`);
    });
    window.webContents.session.webRequest.onErrorOccurred({ urls: ["http://127.0.0.1:*/*", "http://localhost:*/*"] }, (details) => {
      if (details.resourceType === "xhr" || details.resourceType === "mainFrame") noteNetworkError(`${details.method} ${details.url} failed (${details.error})`);
    });
    window.webContents.on("console-message", (_event, _level, message) => {
      if (consoleErrors.length < MAX_DIAGNOSTIC_ENTRIES) consoleErrors.push(String(message).slice(0, 200));
    });
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-attach-webview", (event) => event.preventDefault());
    window.webContents.on("will-navigate", (event, target) => {
      if (!isLoopbackPreviewUrl(target) || new URL(target).origin !== origin) event.preventDefault();
    });
    return {
      load: async (url: string) => {
        if (!isLoopbackPreviewUrl(url) || new URL(url).origin !== origin) throw new Error("Interaction page navigation escaped preview origin");
        requests = 0;
        networkErrors = [];
        consoleErrors = [];
        await window.loadURL(url);
      },
      action: async (step: D2cInteractionActionStep) => { await window.webContents.executeJavaScript(actionScript(step), true); },
      assertion: async (step: D2cInteractionExpectStep) => pollAssertion(window, step),
      settle: async () => { await new Promise((resolvePromise) => setTimeout(resolvePromise, 150)); },
      apiRequestCount: () => requests,
      // Surface the underlying network/console failures so a zero-request scenario is diagnosable.
      diagnostics: () => {
        const entries = [...networkErrors, ...consoleErrors.map((item) => `console: ${item}`)];
        return entries.length > 0 ? entries.join("; ") : undefined;
      },
      close: async () => { if (!window.isDestroyed()) window.destroy(); },
    };
  });
}
