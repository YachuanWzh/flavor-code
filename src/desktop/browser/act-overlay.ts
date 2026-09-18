/**
 * Best-effort visuals for agent actions, injected into the inspected page.
 * The native WebContentsView always paints above the app DOM, so cursor /
 * click / typing feedback must live inside the page itself. The overlay is a
 * closed shadow root that page CSS cannot touch, and it never receives
 * pointer events. Every failure is swallowed by the caller: visuals must not
 * block or fail the underlying action.
 */

import type { ActRequest } from "./act-service.js";
import type { SnapshotCommander } from "./snapshot-service.js";

/** Cursor glide time; deliberately long enough to remain visible to a human. */
export const ACT_CURSOR_MOVE_MS = 650;
/** Short arrival pause before the real click / keyboard input is dispatched. */
export const ACT_CURSOR_ARRIVAL_MS = 180;
export const ACT_OVERLAY_HOST_ID = "__flavor_act_overlay__";

export interface ActTargetBox {
  center: { x: number; y: number };
  rect: { x: number; y: number; width: number; height: number };
}

export interface ActTargetInfo {
  box: ActTargetBox | undefined;
  /** Accessible name for the status label, when the page exposes one. */
  name: string | undefined;
  /** Password inputs must never echo their typed value, even locally. */
  masked: boolean;
}

export interface ActOverlayHighlight {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ActOverlayPayload {
  hide?: boolean;
  cursor?: { x: number; y: number; moveMs: number };
  click?: { x: number; y: number; count: number };
  highlight?: ActOverlayHighlight;
  typing?: { x: number; y: number; text: string | null };
}

/** Bubble / label text is trimmed so the overlay can never be flooded. */
export function previewTypedText(value: string, maxLength = 42): string {
  const collapsed = value.replace(/\s+/g, " ").trim();
  if (collapsed.length <= maxLength) return collapsed;
  return `${collapsed.slice(0, maxLength - 1)}…`;
}

export function buildActOverlayExpression(payload: ActOverlayPayload): string {
  return `(${OVERLAY_SCRIPT})(${JSON.stringify(payload)})`;
}

const OVERLAY_SCRIPT = `function (p) {
  "use strict";
  var ID = "${ACT_OVERLAY_HOST_ID}";
  var host = document.getElementById(ID);
  if (p.hide) {
    if (host && host.parentNode) host.parentNode.removeChild(host);
    return;
  }
  if (host && !host.__f) {
    if (host.parentNode) host.parentNode.removeChild(host);
    host = null;
  }
  if (!host || !host.__f) {
    host = document.createElement("div");
    host.id = ID;
    host.style.setProperty("all", "initial", "important");
    host.style.setProperty("position", "fixed", "important");
    host.style.setProperty("inset", "0", "important");
    host.style.setProperty("display", "block", "important");
    host.style.setProperty("visibility", "visible", "important");
    host.style.setProperty("opacity", "1", "important");
    host.style.setProperty("overflow", "visible", "important");
    host.style.setProperty("z-index", "2147483647", "important");
    host.style.setProperty("pointer-events", "none", "important");
    var shadow = host.attachShadow({ mode: "closed" });
    /* Never use innerHTML: require-trusted-types-for 'script' blocks it on
       many real sites and used to make the entire visual silently disappear. */
    var style = document.createElement("style");
    style.textContent =
      ".cur{position:fixed;left:0;top:0;width:34px;height:34px;opacity:0;filter:drop-shadow(0 3px 9px rgba(10,30,60,.65));will-change:transform;}" +
      ".cur.on{opacity:1;}" +
      ".cur b{position:absolute;left:19px;top:19px;padding:2px 5px;border:1px solid rgba(255,255,255,.9);border-radius:999px;background:#1677df;color:#fff;font:700 9px/1 -apple-system,'Segoe UI',Arial,sans-serif;letter-spacing:.04em;box-shadow:0 2px 7px rgba(10,60,130,.35);}" +
      ".rip{position:fixed;left:0;top:0;width:56px;height:56px;margin:-28px 0 0 -28px;border-radius:50%;border:3px solid rgba(47,136,247,.95);background:rgba(64,150,255,.25);opacity:0;will-change:transform;}" +
      ".rip.go{animation:flRip .85s cubic-bezier(.2,.6,.3,1);}" +
      ".rip.d2{animation-delay:.17s;}" +
      "@keyframes flRip{0%{opacity:.95;transform:scale(.22);}68%{opacity:.4;transform:scale(1.35);}100%{opacity:0;transform:scale(2.15);}}" +
      ".hl{position:fixed;left:0;top:0;border:2px solid rgba(64,150,255,.95);border-radius:8px;background:rgba(64,150,255,.10);box-shadow:0 0 0 4px rgba(64,150,255,.14),0 8px 26px rgba(28,88,170,.28);opacity:0;transition:opacity .16s ease;will-change:transform;}" +
      ".hl.on{opacity:1;}" +
      ".bub{position:fixed;left:0;top:0;max-width:280px;padding:5px 11px;border-radius:999px;background:rgba(22,36,56,.9);color:#eef4fb;font:12px/1.45 -apple-system,'Segoe UI',Arial,sans-serif;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;opacity:0;transition:opacity .18s ease;box-shadow:0 6px 20px rgba(15,35,60,.35);}" +
      ".bub.on{opacity:1;}";
    shadow.appendChild(style);
    function make(className) {
      var element = document.createElement("div");
      element.className = className;
      shadow.appendChild(element);
      return element;
    }
    var hl = make("hl"), rip = make("rip"), bub = make("bub"), cur = make("cur");
    var svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("width", "32");
    svg.setAttribute("height", "32");
    var path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", "M5 3l13.5 7.8-6.2 1.4L9 18.6 5 3z");
    path.setAttribute("fill", "#fff");
    path.setAttribute("stroke", "#126fd1");
    path.setAttribute("stroke-width", "2.4");
    path.setAttribute("stroke-linejoin", "round");
    svg.appendChild(path);
    cur.appendChild(svg);
    var badge = document.createElement("b");
    badge.textContent = "AI";
    cur.appendChild(badge);
    (document.body || document.documentElement).appendChild(host);
    host.__f = {
      cur: cur,
      rip: rip,
      hl: hl,
      bub: bub,
      pos: null, hlT: 0, bubT: 0, curT: 0
    };
  }
  var api = host.__f;
  clearTimeout(api.hlT); clearTimeout(api.bubT); clearTimeout(api.curT);
  var vw = window.innerWidth, vh = window.innerHeight;
  function clamp(v, max) { return v > max ? max : (v < 8 ? 8 : v); }
  /* SVG arrow tip sits at (5,3) in a 24-unit box scaled to 27px. */
  var TIP_X = 5.6, TIP_Y = 3.4;
  if (p.cursor) {
    /* The first action must visibly travel too. Start inside the bottom-right
       of the viewport; later actions continue from the previous fake cursor. */
    var from = api.pos || { x: 18, y: 18 };
    api.cur.style.transition = "transform " + p.cursor.moveMs + "ms cubic-bezier(.22,.7,.25,1), opacity .25s ease";
    api.cur.style.transform = "translate3d(" + from.x + "px," + from.y + "px,0)";
    void api.cur.offsetWidth;
    api.cur.style.transform = "translate3d(" + (p.cursor.x - TIP_X) + "px," + (p.cursor.y - TIP_Y) + "px,0)";
    api.pos = { x: p.cursor.x - TIP_X, y: p.cursor.y - TIP_Y };
    api.cur.classList.add("on");
    api.curT = setTimeout(function () { api.cur.classList.remove("on"); api.pos = null; }, 9000);
  }
  if (p.click) {
    /* The ripple animation owns transform for scale, so position via left/top.
       Using translate here was overwritten by @keyframes and painted at 0,0. */
    api.rip.style.left = p.click.x + "px";
    api.rip.style.top = p.click.y + "px";
    api.rip.classList.remove("go");
    if (p.click.count > 1) api.rip.classList.add("d2"); else api.rip.classList.remove("d2");
    void api.rip.offsetWidth;
    api.rip.classList.add("go");
  }
  if (p.highlight) {
    var w = Math.min(p.highlight.width, vw - p.highlight.x);
    var h = Math.min(p.highlight.height, vh - p.highlight.y);
    api.hl.style.width = (w < 6 ? 6 : w) + "px";
    api.hl.style.height = (h < 6 ? 6 : h) + "px";
    api.hl.style.transform = "translate3d(" + p.highlight.x + "px," + p.highlight.y + "px,0)";
    api.hl.classList.add("on");
    api.hlT = setTimeout(function () { api.hl.classList.remove("on"); }, 1300);
  }
  if (p.typing) {
    api.bub.textContent = p.typing.text === null ? "\\u28ff\\u28ff\\u28ff\\u28ff\\u28ff" : p.typing.text;
    api.bub.style.transform = "translate3d(" + clamp(p.typing.x, vw - 290) + "px," + clamp(p.typing.y, vh - 34) + "px,0)";
    api.bub.classList.add("on");
    api.bubT = setTimeout(function () { api.bub.classList.remove("on"); }, 1600);
  }
}`;

/** Reads element geometry + a human name + whether the value must be masked. */
export async function inspectActTarget(
  commander: SnapshotCommander,
  backendNodeId: number,
  options: { signal?: AbortSignal } = {},
): Promise<ActTargetInfo> {
  // Focus/type can still work when a node starts outside the viewport, while
  // getContentQuads fails. Scroll first and keep all geometry probes
  // best-effort so a single CDP geometry error never removes the fake cursor.
  await commander.sendCommand(
    "DOM.scrollIntoViewIfNeeded",
    { backendNodeId },
    options.signal === undefined ? {} : { signal: options.signal },
  ).catch(() => undefined);
  const [quads, described] = await Promise.all([
    commander.sendCommand<{ quads?: number[][] }>(
      "DOM.getContentQuads",
      { backendNodeId },
      options.signal === undefined ? {} : { signal: options.signal },
    ).catch(() => undefined),
    commander.sendCommand<{ node?: { nodeName?: string; attributes?: string[] } }>(
      "DOM.describeNode",
      { backendNodeId },
      options.signal === undefined ? {} : { signal: options.signal },
    ).catch(() => undefined),
  ]);
  let box = boxFromQuads(quads?.quads?.[0]);
  if (box === undefined) {
    const model = await commander.sendCommand<{
      model?: { content?: number[]; border?: number[] };
    }>(
      "DOM.getBoxModel",
      { backendNodeId },
      options.signal === undefined ? {} : { signal: options.signal },
    ).catch(() => undefined);
    box = boxFromQuads(model?.model?.content ?? model?.model?.border);
  }
  if (box === undefined) {
    const viewport = await commander.sendCommand<{
      result?: { value?: { width?: number; height?: number } };
    }>(
      "Runtime.evaluate",
      { expression: "({width: innerWidth, height: innerHeight})", returnByValue: true },
      options.signal === undefined ? {} : { signal: options.signal },
    ).catch(() => undefined);
    const width = viewport?.result?.value?.width;
    const height = viewport?.result?.value?.height;
    if (width !== undefined && height !== undefined) {
      const x = Math.round(Math.max(24, width / 2));
      const y = Math.round(Math.max(24, height / 2));
      box = { center: { x, y }, rect: { x: x - 2, y: y - 2, width: 4, height: 4 } };
    }
  }
  const attributes = described?.node?.attributes ?? [];
  const attribute = (name: string): string | undefined => {
    for (let index = 0; index + 1 < attributes.length; index += 2) {
      if (attributes[index] === name) return attributes[index + 1];
    }
    return undefined;
  };
  const rawName = attribute("aria-label") ?? attribute("placeholder") ?? attribute("title");
  const nodeName = described?.node?.nodeName ?? "";
  return {
    box,
    name: rawName !== undefined && rawName.trim() !== ""
      ? previewTypedText(rawName, 24)
      : (nodeName === "INPUT" || nodeName === "TEXTAREA") && attribute("id") !== undefined
        ? previewTypedText(attribute("id") as string, 24)
        : undefined,
    masked: (attribute("type") ?? "").toLowerCase() === "password",
  };
}

function boxFromQuads(quad: number[] | undefined): ActTargetBox | undefined {
  if (quad === undefined || quad.length < 8) return undefined;
  const xs = [quad[0] ?? 0, quad[2] ?? 0, quad[4] ?? 0, quad[6] ?? 0];
  const ys = [quad[1] ?? 0, quad[3] ?? 0, quad[5] ?? 0, quad[7] ?? 0];
  const left = Math.min(...xs);
  const top = Math.min(...ys);
  return {
    center: { x: xs.reduce((a, b) => a + b, 0) / 4, y: ys.reduce((a, b) => a + b, 0) / 4 },
    rect: { x: left, y: top, width: Math.max(...xs) - left, height: Math.max(...ys) - top },
  };
}

function evaluate(commander: SnapshotCommander, payload: ActOverlayPayload, signal?: AbortSignal): Promise<unknown> {
  return commander.sendCommand(
    "Runtime.evaluate",
    { expression: buildActOverlayExpression(payload), returnByValue: false },
    signal === undefined ? {} : { signal },
  );
}

/** Injects one overlay instruction batch; exported for pointer (mouse) visuals. */
export function renderOverlay(
  commander: SnapshotCommander,
  payload: ActOverlayPayload,
  signal?: AbortSignal,
): Promise<void> {
  return evaluate(commander, payload, signal).then(() => undefined);
}

/** Waits for the fake cursor glide, abort-resolved. */
export function sleepGlide(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

/**
 * Plays the visual for one action and resolves once the cursor has arrived,
 * i.e. right before the real input event should be dispatched.
 */
export async function playActVisual(
  commander: SnapshotCommander,
  request: ActRequest,
  info: ActTargetInfo,
  options: { signal?: AbortSignal; moveMs?: number } = {},
): Promise<void> {
  if (info.box === undefined) return;
  const moveMs = options.moveMs ?? ACT_CURSOR_MOVE_MS;
  const { center, rect } = info.box;
  const bubble = {
    x: Math.round(rect.x + rect.width + 10),
    y: Math.round(rect.y - 16),
  };
  const highlight: ActOverlayHighlight = {
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  };
  const moveDuration = request.action === "scroll" ? Math.min(moveMs, 280) : moveMs;
  // Movement is deliberately a separate paint from the click/typing feedback.
  // Otherwise the ripple appears at the destination before the fake cursor
  // has arrived, which looks like an unrelated click.
  await evaluate(commander, {
    cursor: { x: Math.round(center.x), y: Math.round(center.y), moveMs: moveDuration },
    highlight,
  }, options.signal);
  await sleepGlide(moveDuration, options.signal);

  const feedback: ActOverlayPayload | undefined = (() => {
    switch (request.action) {
      case "click":
      case "dblclick":
        return {
          click: { x: Math.round(center.x), y: Math.round(center.y), count: request.action === "dblclick" ? 2 : 1 },
        };
      case "fill":
        return {
          click: { x: Math.round(center.x), y: Math.round(center.y), count: 1 },
          typing: { ...bubble, text: info.masked ? null : previewTypedText(request.value ?? "") },
        };
      case "press":
        return {
          click: { x: Math.round(center.x), y: Math.round(center.y), count: 1 },
          typing: { ...bubble, text: `⏎ ${request.key ?? "Enter"}` },
        };
      case "select":
        return {
          click: { x: Math.round(center.x), y: Math.round(center.y), count: 1 },
          typing: { ...bubble, text: `▾ ${previewTypedText(request.value ?? "")}` },
        };
      case "type":
        return {
          click: { x: Math.round(center.x), y: Math.round(center.y), count: 1 },
          typing: { ...bubble, text: info.masked ? null : previewTypedText(request.value ?? "") },
        };
      case "scroll": {
        const deltaY = request.deltaY ?? 0;
        return {
          typing: { ...bubble, text: deltaY <= 0 ? `↕ 向上 ${Math.abs(deltaY)}` : `↕ 向下 ${deltaY}` },
        };
      }
      default:
        return undefined;
    }
  })();
  if (feedback !== undefined) {
    await evaluate(commander, feedback, options.signal);
    await sleepGlide(ACT_CURSOR_ARRIVAL_MS, options.signal);
  }
}

/** Fades the overlay out (panel hidden, tab closed, control handed over). */
export async function hideActVisual(commander: SnapshotCommander): Promise<void> {
  await evaluate(commander, { hide: true }).catch(() => undefined);
}
