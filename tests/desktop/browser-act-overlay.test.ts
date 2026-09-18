import { describe, expect, it } from "vitest";

import {
  ACT_OVERLAY_HOST_ID,
  buildActOverlayExpression,
  inspectActTarget,
  playActVisual,
  previewTypedText,
  type ActTargetInfo,
} from "../../src/desktop/browser/act-overlay.js";
import type { SnapshotCommander } from "../../src/desktop/browser/snapshot-service.js";

interface FakeCall {
  method: string;
  params?: Record<string, unknown>;
}

function fakeCommander(handlers: Record<string, () => unknown> = {}) {
  const calls: FakeCall[] = [];
  const commander = {
    sendCommand: (method: string, params?: Record<string, unknown>): Promise<unknown> => {
      calls.push({ method, ...(params === undefined ? {} : { params }) });
      return Promise.resolve(handlers[method]?.() ?? {});
    },
  } as unknown as SnapshotCommander;
  return { commander, calls };
}

const BOX = {
  center: { x: 60, y: 45 },
  rect: { x: 10, y: 20, width: 100, height: 50 },
};

function info(overrides: Partial<ActTargetInfo> = {}): ActTargetInfo {
  return { box: BOX, name: undefined, masked: false, ...overrides };
}

describe("act overlay expression", () => {
  it("embeds the payload as JSON inside the injected script", () => {
    const expression = buildActOverlayExpression({
      typing: { x: 5, y: 5, text: "提交 </script>\"quote\"" },
    });
    expect(expression).toContain(ACT_OVERLAY_HOST_ID);
    expect(expression).toContain('\\"quote\\"');
    expect(expression.startsWith("(")).toBe(true);
  });

  it("produces syntactically valid JavaScript for Runtime.evaluate", () => {
    const expression = buildActOverlayExpression({
      cursor: { x: 1, y: 2, moveMs: 3 },
      click: { x: 1, y: 2, count: 2 },
      highlight: { x: 0, y: 0, width: 4, height: 5 },
      typing: { x: 6, y: 7, text: "包含 \"引号\" 和 </script>" },
    });
    // Compiles the body without executing it: parses the whole IIFE + payload.
    expect(() => new Function(expression)).not.toThrow();
  });

  it("previewTypedText collapses whitespace and caps length", () => {
    expect(previewTypedText("  hello \n world  ")).toBe("hello world");
    expect(previewTypedText("x".repeat(50), 42).length).toBeLessThanOrEqual(42);
    expect(previewTypedText("x".repeat(50), 42).endsWith("…")).toBe(true);
  });
});

describe("inspectActTarget", () => {
  it("derives center, rect, accessible name and password masking", async () => {
    const { commander } = fakeCommander({
      "DOM.getContentQuads": () => ({ quads: [[10, 20, 110, 20, 110, 70, 10, 70]] }),
      "DOM.describeNode": () => ({
        node: { nodeName: "INPUT", attributes: ["type", "password", "aria-label", " 邮箱 "] },
      }),
    });
    const result = await inspectActTarget(commander, 42);
    expect(result.box).toEqual(BOX);
    expect(result.name).toBe("邮箱");
    expect(result.masked).toBe(true);
  });

  it("survives missing geometry and node metadata", async () => {
    const { commander } = fakeCommander();
    const result = await inspectActTarget(commander, 7);
    expect(result.box).toBeUndefined();
    expect(result.name).toBeUndefined();
    expect(result.masked).toBe(false);
  });
});

describe("playActVisual", () => {
  it("injects cursor + click + highlight for a click and resolves after the glide", async () => {
    const { commander, calls } = fakeCommander();
    await playActVisual(commander, { action: "click", ref: 1 }, info(), { moveMs: 1 });
    const evaluate = calls.find((call) => call.method === "Runtime.evaluate");
    expect(evaluate).toBeDefined();
    const expression = String((evaluate?.params as { expression: string }).expression);
    expect(expression).toContain('"cursor":{"x":60,"y":45,"moveMs":1}');
    expect(expression).toContain('"click":{"x":60,"y":45,"count":1}');
    expect(expression).toContain('"highlight":{');
  });

  it("never echoes password values in the typing bubble", async () => {
    const { commander, calls } = fakeCommander();
    await playActVisual(
      commander,
      { action: "fill", ref: 1, value: "hunter2" },
      info({ masked: true }),
      { moveMs: 1 },
    );
    const expression = String((calls[0]?.params as { expression: string }).expression);
    expect(expression).toContain('"text":null');
    expect(expression).not.toContain("hunter2");
  });

  it("is a no-op when the target has no geometry", async () => {
    const { commander, calls } = fakeCommander();
    await playActVisual(commander, { action: "click", ref: 1 }, info({ box: undefined }), { moveMs: 1 });
    expect(calls.length).toBe(0);
  });
});
