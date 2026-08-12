import type { D2cInteractionActionStep, D2cInteractionExpectStep, D2cInteractionManifest, D2cInteractionRun } from "../d2c/interaction.js";
import { isLoopbackPreviewUrl, runInteractionManifest } from "../d2c/interaction.js";
import type { D2cPageObservation } from "../d2c/interaction-review.js";

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
  observe(manifest: D2cInteractionManifest, baseUrl: string): Promise<D2cPageObservation[]>;
  capture(url: string): Promise<Buffer>;
}

const FRAME_SELECTOR = 'iframe[title="D2C interactive preview"]';
const ASSERTION_TIMEOUT_MS = 3_000;
const VISUALIZER_ID = "flavor-d2c-automation-visualizer";

function visualizerBootstrap(delayMs: number): string {
  const css = `
#${VISUALIZER_ID}{position:fixed;inset:0;z-index:2147483647;pointer-events:none;font-family:Inter,"PingFang SC","Microsoft YaHei",sans-serif;color:#ecfbf8}
#${VISUALIZER_ID} .d2c-auto-status{position:absolute;top:16px;left:50%;display:flex;align-items:center;gap:9px;max-width:min(620px,calc(100vw - 32px));padding:9px 13px;border:1px solid rgba(118,230,209,.42);border-radius:7px;background:rgba(15,37,49,.94);box-shadow:0 10px 28px rgba(5,20,28,.28);transform:translateX(-50%);backdrop-filter:blur(8px);font-size:12px;font-weight:650;line-height:1.25;letter-spacing:.01em;white-space:nowrap}
#${VISUALIZER_ID} .d2c-auto-status i{flex:0 0 auto;width:7px;height:7px;border-radius:50%;background:#31d0b1;box-shadow:0 0 0 5px rgba(49,208,177,.16)}
#${VISUALIZER_ID} .d2c-auto-status span{min-width:0;overflow:hidden;text-overflow:ellipsis}
#${VISUALIZER_ID} .d2c-auto-focus{position:fixed;display:none;border:2px solid #25c7aa;border-radius:7px;background:rgba(37,199,170,.08);box-shadow:0 0 0 4px rgba(37,199,170,.18),0 8px 24px rgba(9,42,48,.16);transition:left .22s ease,top .22s ease,width .22s ease,height .22s ease}
#${VISUALIZER_ID} .d2c-auto-pointer{position:fixed;left:0;top:0;width:18px;height:18px;border:2px solid #fff;border-radius:50%;background:#22bfa4;box-shadow:0 3px 12px rgba(5,42,46,.4);opacity:0;transform:translate(-40px,-40px);transition:transform .3s cubic-bezier(.2,.8,.2,1),opacity .12s ease}
#${VISUALIZER_ID} .d2c-auto-pointer::after{content:"";position:absolute;inset:5px;border-radius:50%;background:#083943}
#${VISUALIZER_ID} .d2c-auto-ripple{position:fixed;width:18px;height:18px;border:2px solid #21c7aa;border-radius:50%;transform:translate(-50%,-50%);animation:d2c-auto-ripple .58s ease-out forwards}
#${VISUALIZER_ID}[data-state="assert"] .d2c-auto-status i{background:#f0ad39;box-shadow:0 0 0 5px rgba(240,173,57,.16)}
#${VISUALIZER_ID}[data-state="pass"] .d2c-auto-status i{background:#43cf7d;box-shadow:0 0 0 5px rgba(67,207,125,.16)}
#${VISUALIZER_ID}[data-state="fail"] .d2c-auto-status{border-color:rgba(239,104,110,.55)}
#${VISUALIZER_ID}[data-state="fail"] .d2c-auto-status i{background:#ef686e;box-shadow:0 0 0 5px rgba(239,104,110,.16)}
@keyframes d2c-auto-ripple{from{opacity:.9;transform:translate(-50%,-50%) scale(.55)}to{opacity:0;transform:translate(-50%,-50%) scale(3.2)}}
@media(prefers-reduced-motion:reduce){#${VISUALIZER_ID} .d2c-auto-focus,#${VISUALIZER_ID} .d2c-auto-pointer{transition:none}#${VISUALIZER_ID} .d2c-auto-ripple{animation:none;display:none}}
`;
  const html = '<style></style><div class="d2c-auto-status"><i></i><span></span></div><div class="d2c-auto-focus"></div><div class="d2c-auto-pointer"></div>';
  return `const d2cDelay = ${delayMs};
    const d2cReducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
    const d2cPause = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
    let d2cVisualizer = document.getElementById(${JSON.stringify(VISUALIZER_ID)});
    if (!d2cVisualizer) {
      d2cVisualizer = document.createElement("div"); d2cVisualizer.id = ${JSON.stringify(VISUALIZER_ID)};
      d2cVisualizer.setAttribute("aria-hidden", "true"); d2cVisualizer.innerHTML = ${JSON.stringify(html)};
      d2cVisualizer.querySelector("style").textContent = ${JSON.stringify(css)};
      (document.body || document.documentElement).appendChild(d2cVisualizer);
    }
    const d2cStatus = d2cVisualizer.querySelector(".d2c-auto-status span");
    const d2cFocus = d2cVisualizer.querySelector(".d2c-auto-focus");
    const d2cPointer = d2cVisualizer.querySelector(".d2c-auto-pointer");
    const d2cPresent = async (target, label, state = "action") => {
      d2cVisualizer.dataset.state = state; d2cStatus.textContent = label;
      if (!target || target === document.body || target === document.documentElement) { d2cFocus.style.display = "none"; return; }
      target.scrollIntoView?.({ block: "center", inline: "center", behavior: d2cReducedMotion ? "auto" : "smooth" });
      await d2cPause(Math.min(260, d2cDelay * .42));
      const rect = target.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) { d2cFocus.style.display = "none"; return; }
      d2cFocus.style.display = "block"; d2cFocus.style.left = (rect.left - 5) + "px"; d2cFocus.style.top = (rect.top - 5) + "px";
      d2cFocus.style.width = (rect.width + 10) + "px"; d2cFocus.style.height = (rect.height + 10) + "px";
      const x = Math.max(8, Math.min(innerWidth - 8, rect.left + rect.width / 2));
      const y = Math.max(8, Math.min(innerHeight - 8, rect.top + rect.height / 2));
      if (d2cPointer.dataset.ready !== "true") {
        d2cPointer.style.transition = "none"; d2cPointer.style.transform = "translate(" + (innerWidth / 2 - 9) + "px," + (innerHeight / 2 - 9) + "px)";
        d2cPointer.getBoundingClientRect(); d2cPointer.style.transition = ""; d2cPointer.dataset.ready = "true";
      }
      const position = "translate(" + (x - 9) + "px," + (y - 9) + "px)";
      d2cPointer.style.setProperty("--d2c-pointer-position", position); d2cPointer.style.transform = position; d2cPointer.style.opacity = "1";
      d2cPointer.dataset.x = String(x); d2cPointer.dataset.y = String(y);
      await d2cPause(Math.min(320, d2cDelay * .55));
    };
    const d2cRipple = () => {
      const ripple = document.createElement("i"); ripple.className = "d2c-auto-ripple";
      ripple.style.left = d2cPointer.dataset.x + "px"; ripple.style.top = d2cPointer.dataset.y + "px";
      d2cVisualizer.appendChild(ripple); setTimeout(() => ripple.remove(), 650);
    };`;
}

function actionDescription(step: D2cInteractionActionStep): string {
  if (step.action === "open") return `打开 ${step.url}`;
  if (step.action === "wait") return `等待 ${step.ms}ms`;
  if (step.action === "click") return `点击 ${step.selector}`;
  if (step.action === "fill") return `输入 ${step.selector}`;
  if (step.action === "select") return `选择 ${step.selector}`;
  if (step.action === "hover") return `悬停 ${step.selector}`;
  if (step.action === "blur") return `离开 ${step.selector}`;
  return `按键 ${step.value}`;
}

function actionScript(step: D2cInteractionActionStep, scenarioId: string, stepNumber: number, delayMs: number): string {
  const label = `自动验收 · ${scenarioId} · 步骤 ${stepNumber} · ${actionDescription(step)}`;
  return `(async () => { const step = ${JSON.stringify(step)}; const fail = (message) => { throw new Error(message); };
    ${visualizerBootstrap(delayMs)}
    if (step.action === "wait") { await d2cPresent(document.body, ${JSON.stringify(label)}); await d2cPause(step.ms); return; }
    if (step.action === "key") { const target = document.activeElement || document.body; await d2cPresent(target, ${JSON.stringify(label)}); await d2cPause(Math.min(220, d2cDelay * .35)); target.dispatchEvent(new KeyboardEvent("keydown", { key: step.value, bubbles: true, cancelable: true })); return; }
    let element = document.querySelector(step.selector);
    if (!element && step.action === "click") {
      const pageControl = (direction) => document.querySelector(direction === "next"
        ? '.page-next,[data-action="next"],[aria-label*="下一"],a[rel="next"]'
        : '.page-prev,[data-action="prev"],[aria-label*="上一"],a[rel="prev"]');
      const scanPages = async (direction) => {
        for (let page = 0; page < 20 && !element; page += 1) {
          const control = pageControl(direction);
          if (!control || control.disabled || control.getAttribute("aria-disabled") === "true") break;
          const before = location.href + '|' + document.body.innerText;
          await d2cPresent(control, "自动验收 · 正在" + (direction === "next" ? "向后" : "向前") + "翻页定位目标");
          control.click(); await d2cPause(Math.max(180, d2cDelay * .55));
          element = document.querySelector(step.selector);
          if (!element && before === location.href + '|' + document.body.innerText) break;
        }
      };
      await scanPages("next"); if (!element) await scanPages("prev");
    }
    if (!element) fail("Interaction element not found after scanning available pages: " + step.selector);
    await d2cPresent(element, ${JSON.stringify(label)});
    if (step.action === "click") {
      if (element.disabled || element.getAttribute("aria-disabled") === "true") fail("Interaction element is disabled: " + step.selector);
      const clickDeadline = Date.now() + 3500; let rect; let point; let style;
      while (Date.now() <= clickDeadline) {
        style = getComputedStyle(element); rect = element.getBoundingClientRect();
        point = rect.width > 0 && rect.height > 0
          ? document.elementFromPoint(Math.max(0, Math.min(innerWidth - 1, rect.left + rect.width / 2)), Math.max(0, Math.min(innerHeight - 1, rect.top + rect.height / 2)))
          : null;
        if (style.pointerEvents !== "none" && rect.width > 0 && rect.height > 0 && (!point || point === element || element.contains(point))) break;
        await d2cPause(60);
      }
      if (style.pointerEvents === "none" || rect.width <= 0 || rect.height <= 0) fail("Interaction element is not clickable after waiting for layout stability: " + step.selector);
      if (point && point !== element && !element.contains(point)) fail("Interaction element remains covered after waiting for transient overlays: " + step.selector + "; covered by " + (point.id ? "#" + point.id : point.className || point.tagName));
      let clickObserved = false; const observeClick = () => { clickObserved = true; }; element.addEventListener("click", observeClick, { once: true });
      const position = d2cPointer.style.getPropertyValue("--d2c-pointer-position"); d2cPointer.style.transform = position + " scale(.78)"; d2cRipple();
      element.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window })); await d2cPause(Math.min(120, d2cDelay * .2));
      element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window })); d2cPointer.style.transform = position; element.click();
      if (!clickObserved) fail("Click was not delivered: " + step.selector); return;
    }
    if (step.action === "hover") { element.dispatchEvent(new MouseEvent("mouseenter", { bubbles: false })); element.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })); element.focus?.(); await d2cPause(d2cDelay); return; }
    if (step.action === "blur") { element.focus?.(); await d2cPause(Math.min(180, d2cDelay * .3)); element.blur?.(); element.dispatchEvent(new FocusEvent("focusout", { bubbles: true })); await d2cPause(Math.max(120, d2cDelay * .45)); return; }
    if (step.action === "fill") { element.focus?.(); const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), "value")?.set;
      const frames = d2cReducedMotion || d2cDelay === 0 ? 1 : Math.min(12, Math.max(1, step.value.length));
      for (let index = 1; index <= frames; index += 1) { const value = step.value.slice(0, Math.ceil(step.value.length * index / frames)); setter ? setter.call(element, value) : element.value = value; element.dispatchEvent(new Event("input", { bubbles: true })); await d2cPause(Math.min(55, d2cDelay / frames)); }
      element.dispatchEvent(new Event("change", { bubbles: true })); await d2cPause(Math.max(120, d2cDelay * .45)); }
    if (step.action === "select") { const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), "value")?.set; setter ? setter.call(element, step.value) : element.value = step.value; element.dispatchEvent(new Event("input", { bubbles: true })); element.dispatchEvent(new Event("change", { bubbles: true })); await d2cPause(Math.max(120, d2cDelay * .45)); }
  })()`;
}

function scenarioScript(scenarioId: string, delayMs: number): string {
  return `(async () => { ${visualizerBootstrap(delayMs)} d2cVisualizer.dataset.state = "action";
    d2cStatus.textContent = ${JSON.stringify(`自动验收 · ${scenarioId} · 正在准备页面`)};
    await d2cPause(Math.min(420, d2cDelay * .65)); })()`;
}

function assertionCueScript(step: D2cInteractionExpectStep, scenarioId: string, stepNumber: number, delayMs: number): string {
  const selector = "selector" in step ? step.selector : "当前页面";
  const label = `自动验收 · ${scenarioId} · 步骤 ${stepNumber} · 检查 ${selector}`;
  return `(async () => { const check = ${JSON.stringify(step)}; ${visualizerBootstrap(delayMs)}
    await d2cPresent(check.selector ? document.querySelector(check.selector) : document.body, ${JSON.stringify(label)}, "assert");
    await d2cPause(Math.min(260, d2cDelay * .4)); })()`;
}

function assertionResultScript(passed: boolean, scenarioId: string, delayMs: number): string {
  return `(async () => { ${visualizerBootstrap(delayMs)} d2cVisualizer.dataset.state = ${JSON.stringify(passed ? "pass" : "fail")};
    d2cStatus.textContent = ${JSON.stringify(`自动验收 · ${scenarioId} · ${passed ? "检查通过" : "检查失败"}`)};
    await d2cPause(${passed ? "Math.min(180, d2cDelay * .28)" : "Math.max(650, d2cDelay)"}); })()`;
}

function scenarioCompleteScript(scenarioId: string, delayMs: number): string {
  return `(async () => { ${visualizerBootstrap(delayMs)} d2cVisualizer.dataset.state = "pass";
    d2cStatus.textContent = ${JSON.stringify(`自动验收 · ${scenarioId} · 操作完成`)};
    d2cFocus.style.display = "none"; await d2cPause(Math.min(420, d2cDelay * .65)); d2cVisualizer.remove(); })()`;
}

function assertionScript(step: D2cInteractionExpectStep): string {
  return `(() => { const step = ${JSON.stringify(step)};
    if (step.expect === "url") { const actual = (location.pathname.replace(/^\\//, "") || "index.html") + location.hash; return { passed: actual === step.value, actual }; }
    const elements = [...document.querySelectorAll(step.selector)]; const element = elements[0];
    if (step.expect === "count") return { passed: elements.length === step.value, actual: String(elements.length) };
    if (step.expect === "not-exists") return { passed: elements.length === 0, actual: String(elements.length) };
    if (step.expect === "hidden") { if (!element) return { passed: true, actual: "element missing" }; const style = getComputedStyle(element); const rect = element.getBoundingClientRect(); const hidden = element.hidden || style.display === "none" || style.visibility === "hidden" || rect.width <= 0 || rect.height <= 0; return { passed: hidden, actual: String(hidden) }; }
    if (!element) return { passed: false, actual: "element missing" };
    if (step.expect === "visible") { const style = getComputedStyle(element); const rect = element.getBoundingClientRect(); const visible = !element.hidden && style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0; return { passed: visible, actual: String(visible) }; }
    if (step.expect === "attribute") { const actual = element.getAttribute(step.name); return { passed: actual === step.value, actual: String(actual) }; }
    if (step.expect === "class") return { passed: element.classList.contains(step.value), actual: element.className };
    if (step.expect === "value") { const actual = String(element.value ?? ""); return { passed: actual === step.value, actual }; }
    const actual = (element.textContent || "").trim(); return { passed: step.expect === "text" ? actual === step.value : actual.includes(step.value), actual };
  })()`;
}

function sameOrigin(frameUrl: string, baseUrl: string): boolean {
  try { return new URL(frameUrl).origin === new URL(baseUrl).origin; }
  catch { return false; }
}

function hasNavigationMarker(frameUrl: string, targetUrl: string): boolean {
  try {
    const frame = new URL(frameUrl);
    const target = new URL(targetUrl);
    return frame.origin === target.origin
      && frame.searchParams.get("__flavor_d2c_run") === target.searchParams.get("__flavor_d2c_run");
  } catch { return false; }
}

function sameRoute(frameUrl: string, targetUrl: string): boolean {
  try {
    const frame = new URL(frameUrl);
    const target = new URL(targetUrl);
    return frame.origin === target.origin && frame.pathname === target.pathname && frame.hash === target.hash;
  } catch { return false; }
}

const OBSERVATION_SCRIPT = `(() => {
  const clean = (value, limit = 500) => String(value || "").replace(/\\s+/g, " ").trim().slice(0, limit);
  const quote = (value) => JSON.stringify(String(value));
  const selectorFor = (element) => {
    if (element.id) return "#" + CSS.escape(element.id);
    for (const name of ["data-testid", "data-test", "data-action", "data-menu", "data-page", "data-tab", "data-open-dialog", "data-open-drawer"]) {
      if (element.hasAttribute(name)) return "[" + name + "=" + quote(element.getAttribute(name)) + "]";
    }
    if (element.getAttribute("name")) return element.tagName.toLowerCase() + "[name=" + quote(element.getAttribute("name")) + "]";
    if (element.getAttribute("aria-label")) return element.tagName.toLowerCase() + "[aria-label=" + quote(element.getAttribute("aria-label")) + "]";
    if (element.tagName === "A" && element.getAttribute("href")) return "a[href=" + quote(element.getAttribute("href")) + "]";
    const parts = []; let current = element;
    while (current && current !== document.body && parts.length < 4) {
      const tag = current.tagName.toLowerCase(); const siblings = [...current.parentElement.children].filter((item) => item.tagName === current.tagName);
      parts.unshift(tag + (siblings.length > 1 ? ":nth-of-type(" + (siblings.indexOf(current) + 1) + ")" : "")); current = current.parentElement;
    }
    return parts.join(" > ");
  };
  const elements = [...document.querySelectorAll('a[href],button,input,select,textarea,[role="button"],[role="menuitem"],[role="tab"],[tabindex]')]
    .filter((element) => !element.closest("#flavor-d2c-automation-visualizer")).slice(0, 500).map((element) => {
      const style = getComputedStyle(element); const rect = element.getBoundingClientRect();
      const label = element.getAttribute("aria-label") || element.labels?.[0]?.textContent || element.getAttribute("title") || element.getAttribute("placeholder");
      return { selector: selectorFor(element), tag: element.tagName.toLowerCase(), ...(element.getAttribute("role") ? { role: element.getAttribute("role") } : {}),
        ...(element.getAttribute("type") ? { type: element.getAttribute("type") } : {}), ...(label ? { label: clean(label, 200) } : {}),
        ...(clean(element.textContent, 300) ? { text: clean(element.textContent, 300) } : {}), ...("value" in element ? { value: clean(element.value, 300) } : {}),
        ...(element.getAttribute("href") ? { href: element.getAttribute("href") } : {}),
        visible: !element.hidden && style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0,
        disabled: Boolean(element.disabled) || element.getAttribute("aria-disabled") === "true" };
    });
  return { url: location.pathname.replace(/^\\//, "") || "index.html", title: clean(document.title, 500),
    viewport: { width: innerWidth, height: innerHeight }, headings: [...document.querySelectorAll("h1,h2,h3")].map((item) => clean(item.textContent, 500)).filter(Boolean).slice(0, 100),
    bodyText: clean(document.body?.innerText, 12000), elements };
})()`;

export function findD2cPreviewFrame(frames: readonly D2cEmbeddedFrame[], baseUrl: string): D2cEmbeddedFrame {
  if (!isLoopbackPreviewUrl(baseUrl)) throw new Error("D2C embedded preview must use loopback HTTP");
  const target = frames.find((frame) => !frame.isDestroyed() && sameOrigin(frame.url, baseUrl));
  if (target === undefined) throw new Error("D2C embedded preview frame is not mounted in the Electron workbench");
  return target;
}

export function createEmbeddedD2cAutomation(
  getHost: () => D2cEmbeddedHost | undefined,
  options: { navigationTimeoutMs?: number; pollIntervalMs?: number; visualDelayMs?: number } = {},
): D2cEmbeddedAutomation {
  const navigationTimeoutMs = options.navigationTimeoutMs ?? 10_000;
  const pollIntervalMs = options.pollIntervalMs ?? 50;
  const visualDelayMs = Math.max(0, Math.min(5_000, options.visualDelayMs ?? 650));
  const host = (): D2cEmbeddedHost => {
    const current = getHost();
    if (current === undefined || current.isDestroyed()) throw new Error("D2C Electron workbench is unavailable");
    return current;
  };
  const frame = (baseUrl: string): D2cEmbeddedFrame => findD2cPreviewFrame(host().mainFrame.framesInSubtree, baseUrl);
  let navigationSequence = 0;
  const navigate = async (url: string): Promise<D2cEmbeddedFrame> => {
    if (!isLoopbackPreviewUrl(url)) throw new Error("D2C embedded navigation must use loopback HTTP");
    const navigationUrl = new URL(url);
    navigationSequence += 1;
    navigationUrl.searchParams.set("__flavor_d2c_run", String(navigationSequence));
    const targetUrl = navigationUrl.toString();
    const currentHost = host();
    await currentHost.mainFrame.executeJavaScript(`(() => { const frame = document.querySelector(${JSON.stringify(FRAME_SELECTOR)}); if (!frame) throw new Error("D2C interactive iframe is not mounted"); frame.src = ${JSON.stringify(targetUrl)}; return true; })()`, true);
    const deadline = Date.now() + navigationTimeoutMs;
    let observedUrl: string | undefined;
    while (Date.now() <= deadline) {
      const candidate = currentHost.mainFrame.framesInSubtree.find((item) => !item.isDestroyed() && hasNavigationMarker(item.url, targetUrl));
      if (candidate !== undefined) {
        observedUrl = candidate.url;
        const ready = await candidate.executeJavaScript("document.readyState", false).catch(() => undefined);
        if (ready === "complete" || ready === "interactive") return candidate;
      }
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
    throw new Error(`D2C embedded preview did not navigate within ${navigationTimeoutMs} ms: ${url}${observedUrl === undefined ? "" : `; last observed ${observedUrl}`}`);
  };
  const visibleFrameRect = async (): Promise<{ x: number; y: number; width: number; height: number }> => {
    const rect = await host().mainFrame.executeJavaScript(`(() => { const frame = document.querySelector(${JSON.stringify(FRAME_SELECTOR)}); if (!frame) throw new Error("D2C interactive iframe is not mounted"); const rect = frame.getBoundingClientRect(); return { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) }; })()`, false) as { x: number; y: number; width: number; height: number };
    if (rect.width <= 0 || rect.height <= 0) throw new Error("D2C embedded preview is not visible");
    return rect;
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
  const settleAfterAction = async (previousUrl: string): Promise<D2cEmbeddedFrame> => {
    const origin = new URL(previousUrl).origin;
    await new Promise((resolve) => setTimeout(resolve, Math.min(180, Math.max(20, visualDelayMs * .25))));
    const deadline = Date.now() + Math.min(2_000, navigationTimeoutMs);
    while (Date.now() <= deadline) {
      const candidate = host().mainFrame.framesInSubtree.find((item) => !item.isDestroyed() && sameOrigin(item.url, origin));
      if (candidate !== undefined) {
        const ready = await candidate.executeJavaScript("document.readyState", false).catch(() => undefined);
        if (ready === "complete" || ready === "interactive") return candidate;
      }
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
    throw new Error("D2C preview frame was unavailable after an interaction action");
  };
  const prepareObservationRoute = async (
    page: D2cInteractionManifest["pages"][number],
    baseUrl: string,
    targetUrl: string,
    initialFrame: D2cEmbeddedFrame,
  ): Promise<D2cEmbeddedFrame> => {
    if (sameRoute(initialFrame.url, targetUrl)) return initialFrame;
    const target = new URL(targetUrl);
    const routeToken = target.hash.replace(/^#\/?/, "").split(/[/?]/u)[0] ?? "";
    const scenario = page.scenarios.find((candidate) => candidate.steps.some((step) =>
      ("expect" in step && step.expect === "url" && sameRoute(new URL(step.value, baseUrl).toString(), targetUrl))
      || ("action" in step && step.action === "click" && routeToken !== "" && step.selector.includes(routeToken)),
    ));
    if (scenario === undefined) {
      throw new Error(`D2C observation reached ${initialFrame.url} instead of ${targetUrl}, and the interaction contract has no safe navigation prefix`);
    }
    let active = initialFrame;
    let stepNumber = 0;
    for (const step of scenario.steps) {
      if (!("action" in step)) continue;
      stepNumber += 1;
      if (step.action === "open") active = await navigate(new URL(step.url, baseUrl).toString());
      else {
        await active.executeJavaScript(actionScript(step, `observe-${scenario.id}`, stepNumber, visualDelayMs), true);
        active = await settleAfterAction(active.url);
      }
      if (sameRoute(active.url, targetUrl)) return active;
    }
    throw new Error(`D2C observation could not reach ${targetUrl}; last observed ${active.url}`);
  };
  return {
    async run(manifest, baseUrl, mockUrl) {
      if (!isLoopbackPreviewUrl(baseUrl) || !isLoopbackPreviewUrl(mockUrl)) throw new Error("D2C embedded automation requires loopback preview and mock URLs");
      const mockOrigin = new URL(mockUrl).origin;
      return runInteractionManifest(manifest, baseUrl, async ({ id: scenarioId }) => {
        let activeUrl = baseUrl;
        let requests = 0;
        let stepNumber = 0;
        return {
          load: async (url) => {
            const loaded = await navigate(url);
            activeUrl = loaded.url;
            await frame(activeUrl).executeJavaScript(scenarioScript(scenarioId, visualDelayMs), true);
          },
          action: async (step) => {
            stepNumber += 1;
            try {
              if (step.action === "open") {
                const target = new URL(step.url, baseUrl).toString();
                const loaded = await navigate(target);
                activeUrl = loaded.url;
                await loaded.executeJavaScript(scenarioScript(scenarioId, visualDelayMs), true);
                return;
              }
              await frame(activeUrl).executeJavaScript(actionScript(step, scenarioId, stepNumber, visualDelayMs), true);
              activeUrl = (await settleAfterAction(activeUrl)).url;
            }
            catch (error) {
              if (step.action === "click") {
                const recovered = await settleAfterAction(activeUrl).catch(() => undefined);
                if (recovered !== undefined && recovered.url !== activeUrl) { activeUrl = recovered.url; return; }
              }
              await frame(activeUrl).executeJavaScript(assertionResultScript(false, scenarioId, visualDelayMs), true).catch(() => undefined);
              throw error;
            }
          },
          assertion: async (step) => {
            stepNumber += 1;
            await frame(activeUrl).executeJavaScript(assertionCueScript(step, scenarioId, stepNumber, visualDelayMs), true);
            const result = await pollAssertion(activeUrl, step);
            await frame(activeUrl).executeJavaScript(assertionResultScript(result.passed, scenarioId, visualDelayMs), true);
            return result;
          },
          settle: async () => {
            await new Promise((resolve) => setTimeout(resolve, 150));
            requests = await frame(activeUrl).executeJavaScript(`performance.getEntriesByType("resource").filter((entry) => {
              try { return ["fetch", "xmlhttprequest"].includes(entry.initiatorType) && new URL(entry.name).origin === ${JSON.stringify(mockOrigin)}; } catch { return false; }
            }).length`, false).catch(() => 0) as number;
            await frame(activeUrl).executeJavaScript(scenarioCompleteScript(scenarioId, visualDelayMs), true);
          },
          apiRequestCount: () => requests,
          close: async () => undefined,
          diagnostics: () => undefined,
        };
      });
    },
    async observe(manifest, baseUrl) {
      if (!isLoopbackPreviewUrl(baseUrl)) throw new Error("D2C embedded observation requires a loopback preview URL");
      const origin = new URL(baseUrl).origin;
      const observations: D2cPageObservation[] = [];
      for (const page of manifest.pages) {
        const url = new URL(page.url, baseUrl).toString();
        if (new URL(url).origin !== origin) throw new Error(`D2C observation escaped preview origin: ${page.url}`);
        const loaded = await navigate(url);
        const prepared = await prepareObservationRoute(page, baseUrl, url, loaded);
        const observation = await prepared.executeJavaScript(OBSERVATION_SCRIPT, false) as Omit<D2cPageObservation, "screenshot">;
        const screenshot = (await host().capturePage(await visibleFrameRect())).toPNG();
        observations.push({ ...observation, url: page.url, screenshot });
      }
      return observations;
    },
    async capture(url) {
      await navigate(url);
      const currentHost = host();
      return (await currentHost.capturePage(await visibleFrameRect())).toPNG();
    },
  };
}
