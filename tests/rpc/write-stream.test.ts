import { describe, expect, it, vi } from "vitest";

import { RpcWriteStreamBridge, streamChunks } from "../../src/rpc/write-stream.js";
import type { SessionOutput } from "../../src/ui/session.js";

describe("RpcWriteStreamBridge", () => {
  it("streams content and waits for an explicit commit", async () => {
    const events: SessionOutput[] = [];
    const bridge = new RpcWriteStreamBridge((event) => events.push(event));
    const preview = bridge.preview({
      path: "C:/work/index.js",
      before: "old\n",
      after: "one\ntwo\n",
      kind: "update",
    }, new AbortController().signal);
    await Promise.resolve();

    expect(events.map((event) => event.type)).toEqual(["write-start", "write-delta", "write-delta", "write-ready"]);
    expect(events.filter((event) => event.type === "write-delta")).toMatchObject([
      { delta: "one\n" },
      { delta: "two\n" },
    ]);
    expect(bridge.pendingId).toMatch(/[0-9a-f-]{36}/);
    bridge.commit(bridge.pendingId!);
    await preview;
  });

  it("chunks large content without changing it", () => {
    const content = `${"a".repeat(2_100)}\nsecond\n`;
    expect(streamChunks(content, 128).join("")).toBe(content);
    expect(streamChunks(content, 128).every((chunk) => chunk.length <= 128)).toBe(true);
  });

  it("rejects stale commit identifiers", () => {
    const bridge = new RpcWriteStreamBridge(vi.fn());
    expect(() => bridge.commit("62b77184-8a91-4ba3-873d-c804c93891ef")).toThrow(/no longer awaiting/i);
  });
});
