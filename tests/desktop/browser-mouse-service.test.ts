import { describe, expect, it } from "vitest";

import { mouseViaCdp, pointerLabel } from "../../src/desktop/browser/mouse-service.js";
import type { SnapshotCommander } from "../../src/desktop/browser/snapshot-service.js";

interface Sent {
  method: string;
  params?: Record<string, unknown>;
}

function fakeCommander(): { commander: SnapshotCommander; sent: Sent[] } {
  const sent: Sent[] = [];
  const commander = {
    sendCommand: (method: string, params?: Record<string, unknown>): Promise<unknown> => {
      sent.push({ method, ...(params === undefined ? {} : { params }) });
      return Promise.resolve({});
    },
  } as unknown as SnapshotCommander;
  return { commander, sent };
}

function mouseEvents(sent: Sent[]): Record<string, unknown>[] {
  return sent.filter((call) => call.method === "Input.dispatchMouseEvent")
    .map((call) => call.params as Record<string, unknown>);
}

describe("mouseViaCdp", () => {
  it("clicks with press/release cycles matching clickCount", async () => {
    const { commander, sent } = fakeCommander();
    await mouseViaCdp(commander, { operation: "click", x: 30.4, y: 40.6, clickCount: 2 });
    const events = mouseEvents(sent);
    expect(events[0]).toMatchObject({ type: "mouseMoved", x: 30, y: 41 });
    expect(events.slice(1).map((event) => `${event.type}:${event.clickCount}`))
      .toEqual(["mousePressed:1", "mouseReleased:1", "mousePressed:2", "mouseReleased:2"]);
  });

  it("drags with interpolated button-held moves", async () => {
    const { commander, sent } = fakeCommander();
    await mouseViaCdp(commander, { operation: "drag", x: 0, y: 0, toX: 100, toY: 0, steps: 4 });
    const events = mouseEvents(sent);
    expect(events[0]).toMatchObject({ type: "mouseMoved" });
    expect(events[1]).toMatchObject({ type: "mousePressed" });
    const held = events.filter((event) => event.type === "mouseMoved" && event.buttons === 1);
    expect(held.map((event) => event.x)).toEqual([25, 50, 75, 100]);
    expect(events.at(-1)).toMatchObject({ type: "mouseReleased", x: 100, y: 0 });
  });

  it("wheels require a non-zero delta and reject bad coordinates", async () => {
    const { commander } = fakeCommander();
    await expect(mouseViaCdp(commander, { operation: "wheel", x: 5, y: 5 })).rejects
      .toThrow(/deltaX or deltaY/);
    await expect(mouseViaCdp(commander, { operation: "click", x: -3, y: 5 })).rejects
      .toThrow(/non-negative/);
  });

  it("pointerLabel describes each operation", () => {
    expect(pointerLabel({ operation: "click", x: 12.2, y: 8 })).toBe("点击 (12, 8)");
    expect(pointerLabel({ operation: "drag", x: 1, y: 2, toX: 30, toY: 40 })).toBe("拖拽 (1, 2) → (30, 40)");
    expect(pointerLabel({ operation: "wheel", x: 0, y: 0, deltaY: -240 })).toBe("滚轮向上 240");
  });
});
