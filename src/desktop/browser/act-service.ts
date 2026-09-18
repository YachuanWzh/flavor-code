/**
 * Action service: resolves a snapshot ref to its live backend node and drives
 * the page through DOM/Input CDP domains only. Coordinates are always taken
 * from the currently resolved node's content quads; stale refs never fall back
 * to old coordinates (md_docs/todo.md sections 10 and 11).
 */

import type { RefRegistry } from "./snapshot.js";
import type { SnapshotCommander } from "./snapshot-service.js";

export interface ActCommandOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface ActRequest {
  action: "click" | "dblclick" | "fill" | "focus" | "hover" | "press" | "select" | "type" | "scroll";
  ref: number;
  value?: string;
  key?: string;
  /** Per-character pause for `type` (0..200 ms, default 15). */
  charDelayMs?: number;
  deltaX?: number;
  deltaY?: number;
}

/** Modifier bitmask per CDP Input.dispatchKeyEvent. */
const MODIFIER_CTRL = 2;

const KEY_DEFINITIONS: Record<string, { key: string; code: string; vk: number; text?: string }> = {
  enter: { key: "Enter", code: "Enter", vk: 13, text: "\r" },
  tab: { key: "Tab", code: "Tab", vk: 9 },
  escape: { key: "Escape", code: "Escape", vk: 27 },
  backspace: { key: "Backspace", code: "Backspace", vk: 8 },
  delete: { key: "Delete", code: "Delete", vk: 46 },
  arrowup: { key: "ArrowUp", code: "ArrowUp", vk: 38 },
  arrowdown: { key: "ArrowDown", code: "ArrowDown", vk: 40 },
  arrowleft: { key: "ArrowLeft", code: "ArrowLeft", vk: 37 },
  arrowright: { key: "ArrowRight", code: "ArrowRight", vk: 39 },
  " ": { key: " ", code: "Space", text: " ", vk: 32 },
};

function command(options: ActCommandOptions): { timeoutMs?: number; signal?: AbortSignal } {
  return options;
}

/** Resolves the ref, asserts it still belongs to a live document and returns its backend node. */
function resolveTarget(registry: RefRegistry, ref: number): number {
  const resolved = registry.resolve(ref);
  if (resolved.frameId !== "main") {
    // Subframes share the page target but their nodes resolve in the child
    // frame session; the MVP snapshot only emits main-frame nodes.
    throw new Error(`Ref @${ref} is in a non-main frame and not actionable yet`);
  }
  return resolved.backendNodeId;
}

async function nodeCenter(commander: SnapshotCommander, backendNodeId: number, options: ActCommandOptions) {
  const quads = await commander.sendCommand<{ quads?: number[][] }>(
    "DOM.getContentQuads",
    { backendNodeId },
    command(options),
  );
  const quad = quads.quads?.[0];
  if (quad === undefined || quad.length < 8) {
    throw new Error("Element has no visible geometry; scroll it into view first");
  }
  const at = (index: number): number => quad[index] ?? 0;
  return {
    x: (at(0) + at(2) + at(4) + at(6)) / 4,
    y: (at(1) + at(3) + at(5) + at(7)) / 4,
  };
}

export async function actViaRef(
  commander: SnapshotCommander,
  registry: RefRegistry,
  request: ActRequest,
  options: ActCommandOptions = {},
): Promise<{ action: ActRequest["action"]; ref: number }> {
  const backendNodeId = resolveTarget(registry, request.ref);
  switch (request.action) {
    case "click": {
      await focusNode(commander, backendNodeId, options);
      await mouseClick(commander, backendNodeId, 1, options);
      break;
    }
    case "dblclick": {
      await focusNode(commander, backendNodeId, options);
      await mouseClick(commander, backendNodeId, 2, options);
      break;
    }
    case "hover": {
      const { x, y } = await nodeCenter(commander, backendNodeId, options);
      await commander.sendCommand("Input.dispatchMouseEvent", { type: "mouseMoved", x, y }, command(options));
      break;
    }
    case "focus": {
      await focusNode(commander, backendNodeId, options);
      break;
    }
    case "fill": {
      const value = request.value ?? "";
      await focusNode(commander, backendNodeId, options);
      // Select existing content (Ctrl+A) then replace it with insertText.
      await commander.sendCommand(
        "Input.dispatchKeyEvent",
        { type: "keyDown", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: MODIFIER_CTRL },
        command(options),
      );
      await commander.sendCommand(
        "Input.dispatchKeyEvent",
        { type: "keyUp", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: MODIFIER_CTRL },
        command(options),
      );
      if (value !== "") {
        await commander.sendCommand("Input.insertText", { text: value }, command(options));
      }
      break;
    }
    case "select": {
      // Select a native <option> without depending on the popup that a click
      // would open: set selectedIndex through the isolated world.
      const value = request.value ?? "";
      await commander.sendCommand(
        "DOM.setNodeValue",
        { backendNodeId, value },
        command(options),
      ).catch(() => undefined);
      const changed =
        `this.selectedIndex = Array.prototype.findIndex.call(this.options, (option) => option.value === ${JSON.stringify(value)}); ` +
        "this.dispatchEvent(new Event('input', { bubbles: true })); this.dispatchEvent(new Event('change', { bubbles: true }));";
      const evaluated = await commander.sendCommand<{ wasThrown?: boolean; value?: unknown }>(
        "Runtime.callFunctionOn",
        { backendNodeId, functionDeclaration: `function() { ${changed} }`, returnByValue: true },
        command(options),
      );
      if (evaluated.wasThrown === true) {
        throw new Error("Select option failed");
      }
      break;
    }
    case "type": {
      // Character-by-character key events (unlike fill's insertText): pages
      // that listen for keydown/keyup autocomplete hooks see real typing.
      const text = request.value ?? "";
      if (text.length > 4_000) {
        throw new Error("type text is limited to 4000 characters; use fill for large values");
      }
      const charDelay = Math.max(0, Math.min(200, request.charDelayMs ?? 15));
      await focusNode(commander, backendNodeId, options);
      for (let index = 0; index < text.length; index += 1) {
        const character = text[index] as string;
        const info = keyCodeInfo(character);
        const base = { key: character, code: info.code, windowsVirtualKeyCode: info.vk };
        if (character === "\n") {
          await commander.sendCommand(
            "Input.dispatchKeyEvent",
            { type: "keyDown", ...base, text: "\r", unmodifiedText: "\r" },
            command(options),
          );
        } else {
          await commander.sendCommand(
            "Input.dispatchKeyEvent",
            { type: "keyDown", ...base, text: character, unmodifiedText: character },
            command(options),
          );
        }
        await commander.sendCommand(
          "Input.dispatchKeyEvent",
          { type: "keyUp", ...base },
          command(options),
        );
        if (charDelay > 0 && index < text.length - 1) {
          await sleepWithSignal(charDelay, options.signal);
        }
      }
      break;
    }
    case "scroll": {
      const deltaX = Math.round(request.deltaX ?? 0);
      const deltaY = Math.round(request.deltaY ?? 0);
      if (deltaX === 0 && deltaY === 0) {
        throw new Error("scroll needs a non-zero deltaX or deltaY");
      }
      const { x, y } = await nodeCenter(commander, backendNodeId, options);
      await commander.sendCommand(
        "Input.dispatchMouseEvent",
        { type: "mouseWheel", x, y, deltaX, deltaY },
        command(options),
      );
      break;
    }
    case "press": {
      await focusNode(commander, backendNodeId, options);
      const keyName = request.key ?? "Enter";
      const definition = KEY_DEFINITIONS[keyName.toLowerCase()];
      if (definition === undefined) {
        throw new Error(`Unsupported press key "${keyName}"; combine characters with fill for text input`);
      }
      const base = {
        key: definition.key,
        code: definition.code,
        windowsVirtualKeyCode: definition.vk,
      };
      if (definition.text === undefined) {
        await commander.sendCommand("Input.dispatchKeyEvent", { type: "rawKeyDown", ...base }, command(options));
      } else {
        await commander.sendCommand("Input.dispatchKeyEvent", { type: "keyDown", ...base, text: definition.text }, command(options));
      }
      await commander.sendCommand("Input.dispatchKeyEvent", { type: "keyUp", ...base }, command(options));
      break;
    }
  }
  return { action: request.action, ref: request.ref };
}

async function focusNode(commander: SnapshotCommander, backendNodeId: number, options: ActCommandOptions): Promise<void> {
  await commander.sendCommand("DOM.focus", { backendNodeId }, command(options));
}

function keyCodeInfo(character: string): { code: string; vk: number } {
  const upper = character.toUpperCase();
  if (/^[A-Z]$/.test(upper)) return { code: `Key${upper}`, vk: upper.charCodeAt(0) };
  if (/^[0-9]$/.test(character)) return { code: `Digit${character}`, vk: character.charCodeAt(0) };
  if (character === " ") return { code: "Space", vk: 32 };
  if (character === "\n") return { code: "Enter", vk: 13 };
  if (character === "\t") return { code: "Tab", vk: 9 };
  const vk = upper.charCodeAt(0);
  return { code: "Unidentified", vk: Number.isFinite(vk) ? vk : 0 };
}

function sleepWithSignal(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) return Promise.reject(signal.reason ?? new Error("aborted"));
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

async function mouseClick(
  commander: SnapshotCommander,
  backendNodeId: number,
  clickCount: number,
  options: ActCommandOptions,
): Promise<void> {
  const { x, y } = await nodeCenter(commander, backendNodeId, options);
  await commander.sendCommand(
    "Input.dispatchMouseEvent",
    { type: "mousePressed", x, y, button: "left", clickCount },
    command(options),
  );
  await commander.sendCommand(
    "Input.dispatchMouseEvent",
    { type: "mouseReleased", x, y, button: "left", clickCount },
    command(options),
  );
}
