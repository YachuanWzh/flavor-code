import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";

import { FlavorRpcServer } from "../../src/rpc/server.js";
import type { SessionOutput } from "../../src/ui/session.js";

describe("FlavorRpcServer", () => {
  it("survives malformed input and accepts prompt, steering, state, and shutdown", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let outputEvent!: (event: SessionOutput) => void;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const runtime = {
      sessionId: "session-rpc",
      session: {
        active: true,
        start: vi.fn(async () => undefined),
        submit: vi.fn(async () => { await gate; }),
        steer: vi.fn(),
        followUp: vi.fn(),
        interrupt: vi.fn(() => "cancelled" as const),
        queueSnapshot: vi.fn(() => ({ steering: ["adjust"], followUp: [] })),
        clearQueue: vi.fn(() => ({ steering: [], followUp: [] })),
        whenIdle: vi.fn(async () => undefined),
        close: vi.fn(async () => undefined),
      },
      services: {
        checkpoint: vi.fn(async () => ({ id: "turn-1", checkpointId: "checkpoint-1" })),
        tree: vi.fn(() => [{ id: "turn-1", parentId: null }]),
        rewind: vi.fn(async () => undefined),
        unrevert: vi.fn(async () => undefined),
        fork: vi.fn(async () => undefined),
      },
      dispose: vi.fn(async () => undefined),
    };
    const server = new FlavorRpcServer({
      input, output, workspace: "/work",
      createRuntime: async (options) => { outputEvent = options.output; return runtime; },
    });
    const records: unknown[] = [];
    output.on("data", (chunk) => {
      for (const line of chunk.toString("utf8").trim().split("\n")) if (line) records.push(JSON.parse(line));
    });
    const running = server.start();

    input.write("{bad json}\n");
    input.write('{"id":"1","type":"prompt","message":"work"}\n');
    input.write('{"id":"2","type":"steer","message":"adjust"}\n');
    input.write('{"id":"3","type":"get_state"}\n');
    input.write('{"id":"tree","type":"get_tree"}\n');
    input.write('{"id":"rewind","type":"rewind","nodeId":"turn-1"}\n');
    await new Promise((resolve) => setTimeout(resolve, 10));
    outputEvent({ type: "text", text: "stream" });
    input.write('{"id":"4","type":"shutdown"}\n');
    release();
    await running;

    expect(runtime.session.steer).toHaveBeenCalledWith("adjust");
    expect(runtime.services.rewind).toHaveBeenCalledWith("turn-1");
    expect(records).toContainEqual(expect.objectContaining({ type: "error", code: "invalid_json" }));
    expect(records).toContainEqual(expect.objectContaining({ id: "1", type: "response", success: true }));
    expect(records).toContainEqual(expect.objectContaining({ type: "event", event: { type: "text", text: "stream" } }));
    expect(records).toContainEqual(expect.objectContaining({
      id: "3", type: "response", data: expect.objectContaining({ sessionId: "session-rpc", active: true }),
    }));
    expect(runtime.dispose).toHaveBeenCalledOnce();
  });
});
