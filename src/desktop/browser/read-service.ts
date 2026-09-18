/**
 * Page-data reading for the agent: unlike the accessibility snapshot (which
 * only carries the interactive skeleton), this returns real page content —
 * visible text, markup, form values, attributes and links — scoped to the
 * whole document, a CSS selector, or a snapshot ref.
 */

import type { RefRegistry } from "./snapshot.js";
import type { SnapshotCommander } from "./snapshot-service.js";
import { BrowserError } from "./types.js";

export type ReadMode = "text" | "html" | "value" | "attributes" | "links";

export const READ_MODES: readonly ReadMode[] = ["text", "html", "value", "attributes", "links"];

export interface ReadRequest {
  mode: ReadMode;
  /** Snapshot ref (@N) — takes precedence over selector when present. */
  ref?: number;
  selector?: string;
  maxChars?: number;
}

export interface ReadResult {
  mode: ReadMode;
  scope: "document" | "selector" | "ref";
  truncated: boolean;
  text: string;
}

export const READ_DEFAULT_MAX_CHARS = 20_000;
export const READ_HARD_MAX_CHARS = 100_000;

/** Runs inside the page main world; must stay a self-contained expression. */
export const READ_PAGE_FUNCTION = `function (spec) {
  var el = spec.selector ? document.querySelector(spec.selector) : (this || document.body);
  if (!el) { throw new Error("No element matches selector " + spec.selector); }
  var tag = el && el.tagName ? String(el.tagName).toLowerCase() : "";
  function clean(value) { return String(value === undefined || value === null ? "" : value).replace(/\\r/g, ""); }
  function textOf(node) { return clean(node.innerText !== undefined ? node.innerText : node.textContent); }
  switch (spec.mode) {
    case "html":
      return clean(el.outerHTML !== undefined ? el.outerHTML : el.innerHTML);
    case "value":
      return typeof el.value === "string" ? el.value : textOf(el);
    case "attributes": {
      var pairs = [];
      var attrs = el.attributes;
      if (attrs) {
        for (var i = 0; i < attrs.length; i++) {
          var a = attrs[i];
          var v = a.name === "type" && a.value === "password" ? "***" : a.value;
          if (a.name.toLowerCase().indexOf("href") === 0 && /^javascript:/i.test(v)) v = "(blocked)";
          pairs.push(a.name + "=" + v);
        }
      }
      return tag + " " + pairs.join(" ");
    }
    case "links": {
      var list = [];
      var scope = el.querySelectorAll ? el : document;
      var anchors = scope.querySelectorAll("a[href]");
      for (var j = 0; j < anchors.length && list.length < spec.maxLinks; j++) {
        var anchor = anchors[j];
        var label = clean(anchor.innerText || anchor.textContent).replace(/\\s+/g, " ").trim();
        var href = anchor.href || "";
        if (/^javascript:/i.test(href)) continue;
        list.push((label === "" ? "(no text)" : label) + " -> " + href);
      }
      return list.join("\\n");
    }
    default:
      return textOf(el);
  }
}`;

interface EvaluateOutcome {
  result?: { type?: string; value?: unknown; wasThrown?: boolean; className?: string; description?: string };
  exceptionDetails?: { text?: string; exception?: { description?: string } };
}

function throwReadFailure(details: EvaluateOutcome["exceptionDetails"]): never {
  const message = details?.exception?.description ?? details?.text ?? "Read failed in page";
  throw new BrowserError("bad-input", message.split("\n")[0] ?? message);
}

export async function readViaCdp(
  commander: SnapshotCommander,
  registry: RefRegistry,
  request: ReadRequest,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<ReadResult> {
  const maxChars = Math.max(200, Math.min(request.maxChars ?? READ_DEFAULT_MAX_CHARS, READ_HARD_MAX_CHARS));
  const spec = {
    mode: request.mode,
    selector: request.selector ?? null,
    maxLinks: 200,
  };
  const commandOptions = options;
  let raw: string;
  let scope: ReadResult["scope"];
  if (request.ref !== undefined) {
    const target = registry.resolve(request.ref);
    if (target.frameId !== "main") {
      throw new BrowserError("bad-locator", "Read targets in subframes are not supported yet");
    }
    scope = "ref";
    const resolved = await commander.sendCommand<{ object?: { objectId?: string } }>(
      "DOM.resolveNode",
      { backendNodeId: target.backendNodeId },
      commandOptions,
    );
    const objectId = resolved.object?.objectId;
    if (objectId === undefined) {
      throw new BrowserError("stale-ref", `Element reference @${request.ref} can no longer be resolved`);
    }
    try {
      const call = await commander.sendCommand<EvaluateOutcome>("Runtime.callFunctionOn", {
        objectId,
        functionDeclaration: READ_PAGE_FUNCTION,
        arguments: [{ value: spec }],
        returnByValue: true,
      }, commandOptions);
      if (call.exceptionDetails !== undefined || call.result === undefined) {
        throwReadFailure(call.exceptionDetails
          ?? (call.result?.description === undefined ? undefined : { text: call.result.description }));
      }
      raw = typeof call.result.value === "string"
        ? call.result.value
        : JSON.stringify(call.result.value ?? null);
    } finally {
      await commander.sendCommand("Runtime.releaseObject", { objectId }, commandOptions).catch(() => undefined);
    }
  } else {
    scope = request.selector !== undefined ? "selector" : "document";
    const expression = `(${READ_PAGE_FUNCTION}).call(undefined, ${JSON.stringify(spec)})`;
    const evaluated = await commander.sendCommand<EvaluateOutcome>(
      "Runtime.evaluate",
      { expression, returnByValue: true },
      commandOptions,
    );
    const outcome = evaluated.result;
    if (outcome?.wasThrown === true || outcome === undefined) {
      throwReadFailure(evaluated.exceptionDetails
        ?? (outcome?.description === undefined ? undefined : { text: outcome.description }));
    }
    raw = typeof outcome?.value === "string" ? outcome.value : JSON.stringify(outcome?.value ?? null);
  }
  const normalized = raw.replace(/\n{3,}/g, "\n\n");
  const truncated = normalized.length > maxChars;
  return {
    mode: request.mode,
    scope,
    truncated,
    text: truncated ? normalized.slice(0, maxChars) : normalized,
  };
}
