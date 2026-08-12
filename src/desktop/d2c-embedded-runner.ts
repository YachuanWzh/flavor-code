import type { D2cInteractionActionStep, D2cInteractionExpectStep, D2cInteractionManifest, D2cInteractionRun } from "../d2c/interaction.js";
import { isLoopbackPreviewUrl, runInteractionManifest } from "../d2c/interaction.js";

export interface D2cEmbeddedFrame {
  url: string;
  isDestroyed(): boolean;
  executeJavaScript(code: string, userGesture?: boolean): Promise<unknown>;
  framesInSubtree?: D2cEmbeddedFrame[];
}

export interface D2cEmbeddedHost {
  isDestroyed(): boolean;
  mainFrame: D2cEmbeddedFrame & { framesInSubtree: D2cEmbeddedFrame[] };
  capturePage(rect: { x: number; y: number; width: number; height: number }): Promise<{ toPNG(): Buffer }>;
}

export interface D2cEmbeddedAutomation {
  run(manifest: D2cInteractionManifest, baseUrl: string, mockUrl: string): Promise<D2cInteractionRun>;
  capture(url: string): Promise<Buffer>;
}

const FRAME_SELECTOR = 'iframe[title="D2C interactive preview"]';
const ASSERTION_TIMEOUT_MS = 3_000;

function actionScript(step: D2cInteractionActionStep): string {
  return `(() => { const step = ${JSON.stringify(step)}; const fail = (message) => { throw new Error(message); };
    if (step.action === "key") { const target = document.activeElement || document.body; target.dispatchEvent(new KeyboardEvent("keydown", { key: step.value, bubbles: true, cancelable: true })); return; }
    const element = document.querySelector(step.selector); if (!element) fail("Interaction element not found: " + step.selector);
    if (step.action === "click") { element.click(); return; }
    if (step.action === "hover") { element.dispatchEvent(new MouseEvent("mouseenter", { bubbles: false })); element.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })); element.focus?.(); return; }
    if (step.action === "fill") { element.focus?.(); const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), "value")?.set; setter ? setter.call(element, step.value) : element.value = step.value; element.dispatchEvent(new Event("input", { bubbles: true })); element.dispatchEvent(new Event("change", { bubbles: true })); }
  })()`;
}

function assertionScript(step: D2cInteractionExpectStep): string {
  return `(() => { const step = ${JSON.stringify(step)}; const elements = [...document.querySelectorAll(step.selector)]; const element = elements[0];
    if (step.expect === "count") return { passed: elements.length === step.value, actual: String(elements.length) };
    if (!element) return { passed: false, actual: "element missing" };
    if (step.expect === "visible") { const style = getComputedStyle(element); const rect = element.getBoundingClientRect(); const visible = !element.hidden && style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0; return { passed: visible, actual: String(visible) }; }
    if (step.expect === "attribute") { const actual = element.getAttribute(step.name); return { passed: actual === step.value, actual: String(actual) }; }
    if (step.expect === "class") return { passed: element.classList.contains(step.value), actual: element.className };
    const actual = (element.textContent || "").trim(); return { passed: step.expect === "text" ? actual === step.value : actual.includes(step.value), actual };
  })()`;
}

function sameOrigin(frameUrl: string, baseUrl: string): boolean {
  try { return new URL(frameUrl).origin === new URL(baseUrl).origin; }
  catch { return false; }
}

export function findD2cPreviewFrame(frames: readonly D2cEmbeddedFrame[], baseUrl: string): D2cEmbeddedFrame {
  if (!isLoopbackPreviewUrl(baseUrl)) throw new Error("D2C embedded preview must use loopback HTTP");
  const target = frames.find((frame) => !frame.isDestroyed() && sameOrigin(frame.url, baseUrl));
  if (target === undefined) throw new Error("D2C embedded preview frame is not mounted in the Electron workbench");
  return target;
}

export function createEmbeddedD2cAutomation(
  getHost: () => D2cEmbeddedHost | undefined,
  options: { navigationTimeoutMs?: number; pollIntervalMs?: number } = {},
): D2cEmbeddedAutomation {
  const navigationTimeoutMs = options.navigationTimeoutMs ?? 10_000;
  const pollIntervalMs = options.pollIntervalMs ?? 50;
  const host = (): D2cEmbeddedHost => {
    const current = getHost();
    if (current === undefined || current.isDestroyed()) throw new Error("D2C Electron workbench is unavailable");
    return current;
  };
  const frame = (baseUrl: string): D2cEmbeddedFrame => findD2cPreviewFrame(host().mainFrame.framesInSubtree, baseUrl);
  const navigate = async (url: string): Promise<D2cEmbeddedFrame> => {
    if (!isLoopbackPreviewUrl(url)) throw new Error("D2C embedded navigation must use loopback HTTP");
    const currentHost = host();
    await currentHost.mainFrame.executeJavaScript(`(() => { const frame = document.querySelector(${JSON.stringify(FRAME_SELECTOR)}); if (!frame) throw new Error("D2C interactive iframe is not mounted"); frame.src = ${JSON.stringify(url)}; return true; })()`, true);
    const deadline = Date.now() + navigationTimeoutMs;
    while (Date.now() <= deadline) {
      const candidate = currentHost.mainFrame.framesInSubtree.find((item) => !item.isDestroyed() && item.url === url);
      if (candidate !== undefined) {
        const ready = await candidate.executeJavaScript("document.readyState", false).catch(() => undefined);
        if (ready === "complete" || ready === "interactive") return candidate;
      }
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
    throw new Error(`D2C embedded preview did not navigate within ${navigationTimeoutMs} ms: ${url}`);
  };
  const pollAssertion = async (baseUrl: string, step: D2cInteractionExpectStep): Promise<{ passed: boolean; actual?: string }> => {
    const deadline = Date.now() + ASSERTION_TIMEOUT_MS;
    let last: { passed: boolean; actual?: string } = { passed: false };
    while (Date.now() <= deadline) {
      last = await frame(baseUrl).executeJavaScript(assertionScript(step), true) as { passed: boolean; actual?: string };
      if (last.passed) return last;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return last;
  };
  return {
    async run(manifest, baseUrl, mockUrl) {
      if (!isLoopbackPreviewUrl(baseUrl) || !isLoopbackPreviewUrl(mockUrl)) throw new Error("D2C embedded automation requires loopback preview and mock URLs");
      const mockOrigin = new URL(mockUrl).origin;
      return runInteractionManifest(manifest, baseUrl, async () => {
        let activeUrl = baseUrl;
        let requests = 0;
        return {
          load: async (url) => { activeUrl = url; await navigate(url); },
          action: async (step) => { await frame(activeUrl).executeJavaScript(actionScript(step), true); },
          assertion: async (step) => pollAssertion(activeUrl, step),
          settle: async () => {
            await new Promise((resolve) => setTimeout(resolve, 150));
            requests = await frame(activeUrl).executeJavaScript(`performance.getEntriesByType("resource").filter((entry) => {
              try { return ["fetch", "xmlhttprequest"].includes(entry.initiatorType) && new URL(entry.name).origin === ${JSON.stringify(mockOrigin)}; } catch { return false; }
            }).length`, false).catch(() => 0) as number;
          },
          apiRequestCount: () => requests,
          close: async () => undefined,
          diagnostics: () => undefined,
        };
      });
    },
    async capture(url) {
      await navigate(url);
      const currentHost = host();
      const rect = await currentHost.mainFrame.executeJavaScript(`(() => { const frame = document.querySelector(${JSON.stringify(FRAME_SELECTOR)}); if (!frame) throw new Error("D2C interactive iframe is not mounted"); const rect = frame.getBoundingClientRect(); return { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) }; })()`, false) as { x: number; y: number; width: number; height: number };
      if (rect.width <= 0 || rect.height <= 0) throw new Error("D2C embedded preview is not visible");
      return (await currentHost.capturePage(rect)).toPNG();
    },
  };
}
