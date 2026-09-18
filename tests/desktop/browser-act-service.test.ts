import { describe, expect, it } from "vitest";

import { actViaRef } from "../../src/desktop/browser/act-service.js";
import type { SnapshotCommander } from "../../src/desktop/browser/snapshot-service.js";
import { RefRegistry } from "../../src/desktop/browser/snapshot.js";

interface Sent {
  method: string;
  params: Record<string, unknown> | undefined;
}

class RecordingCommander implements SnapshotCommander {
  sent: Sent[] = [];
  responses = new Map<string, unknown>();
  sendCommand<T>(method: string, params?: Record<string, unknown>): Promise<T> {
    this.sent.push({ method, params });
    return Promise.resolve((this.responses.get(method) ?? {}) as T);
  }
}

function registryWith(...backendNodeIds: number[]): RefRegistry {
  const registry = new RefRegistry("bspace-1", "btab-1");
  registry.replaceDocument(
    "doc-1",
    backendNodeIds.map((backendNodeId) => ({
      frameId: "main",
      backendNodeId,
      role: "button",
      name: `b${backendNodeId}`,
    })),
  );
  return registry;
}

describe("act service", () => {
  it("clicks using fresh geometry from the resolved backend node", async () => {
    const commander = new RecordingCommander();
    commander.responses.set("DOM.getContentQuads", {
      quads: [[10, 20, 110, 20, 110, 60, 10, 60]],
    });
    const registry = registryWith(77, 88);
    await actViaRef(commander, registry, { action: "click", ref: 2 });
    expect(commander.sent.map((entry) => entry.method)).toEqual([
      "DOM.focus",
      "DOM.getContentQuads",
      "Input.dispatchMouseEvent",
      "Input.dispatchMouseEvent",
    ]);
    expect(commander.sent[0]?.params).toEqual({ backendNodeId: 88 });
    const pressed = commander.sent[2]?.params;
    expect(pressed).toMatchObject({ type: "mousePressed", x: 60, y: 40, button: "left", clickCount: 1 });
    expect(commander.sent[3]?.params).toMatchObject({ type: "mouseReleased" });
  });

  it("fills by focusing, selecting all, then inserting text", async () => {
    const commander = new RecordingCommander();
    const registry = registryWith(77);
    await actViaRef(commander, registry, { action: "fill", ref: 1, value: "hello" });
    expect(commander.sent.map((entry) => entry.method)).toEqual([
      "DOM.focus",
      "Input.dispatchKeyEvent",
      "Input.dispatchKeyEvent",
      "Input.insertText",
    ]);
    expect(commander.sent.at(-1)?.params).toEqual({ text: "hello" });
    expect(commander.sent[1]?.params).toMatchObject({ type: "keyDown", key: "a", modifiers: 2 });
  });

  it("selects through a resolved runtime object and releases it", async () => {
    const commander = new RecordingCommander();
    commander.responses.set("DOM.resolveNode", { object: { objectId: "select-77" } });
    commander.responses.set("Runtime.callFunctionOn", { result: { value: true } });
    const registry = registryWith(77);
    await actViaRef(commander, registry, { action: "select", ref: 1, value: "green" });
    expect(commander.sent.map((entry) => entry.method)).toEqual([
      "DOM.resolveNode", "Runtime.callFunctionOn", "Runtime.releaseObject",
    ]);
    expect(commander.sent[0]?.params).toEqual({ backendNodeId: 77 });
    expect(commander.sent[1]?.params).toMatchObject({
      objectId: "select-77",
      arguments: [{ value: "green" }],
      returnByValue: true,
    });
  });

  it("presses Enter with a raw key sequence", async () => {
    const commander = new RecordingCommander();
    const registry = registryWith(77);
    await actViaRef(commander, registry, { action: "press", ref: 1, key: "Enter" });
    expect(commander.sent.map((entry) => entry.method)).toEqual([
      "DOM.focus",
      "Input.dispatchKeyEvent",
      "Input.dispatchKeyEvent",
    ]);
    expect(commander.sent[1]?.params).toMatchObject({ type: "keyDown", key: "Enter", text: "\r" });
  });

  it("stale refs fail before any input is dispatched", async () => {
    const commander = new RecordingCommander();
    const registry = registryWith(77);
    registry.invalidateDocument();
    await expect(actViaRef(commander, registry, { action: "click", ref: 1 })).rejects.toThrow(/stale/i);
    expect(commander.sent).toHaveLength(0);
  });

  it("invisible nodes report a scroll-into-view problem, never old coordinates", async () => {
    const commander = new RecordingCommander();
    commander.responses.set("DOM.getContentQuads", { quads: [] });
    const registry = registryWith(77);
    await expect(actViaRef(commander, registry, { action: "click", ref: 1 })).rejects.toThrow(/scroll it into view/);
  });

  it("unknown press keys are rejected instead of guessed", async () => {
    const commander = new RecordingCommander();
    const registry = registryWith(77);
    await expect(
      actViaRef(commander, registry, { action: "press", ref: 1, key: "F13" }),
    ).rejects.toThrow(/Unsupported press key/);
  });
});
