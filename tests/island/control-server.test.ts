import net from "node:net";
import { describe, expect, it, vi } from "vitest";
import { createIslandControlServer } from "../../src/island/control-server.js";

function request(endpoint: string, payload: unknown): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(endpoint);
    let response = "";
    socket.on("connect", () => socket.write(`${JSON.stringify(payload)}\n`));
    socket.on("data", (chunk) => { response += chunk.toString("utf8"); });
    socket.on("end", () => resolve(JSON.parse(response) as Record<string, unknown>));
    socket.on("error", reject);
  });
}

describe("Flavor Island control server", () => {
  it("authenticates local commands and dispatches session controls", async () => {
    const session = {
      steer: vi.fn(),
      followUp: vi.fn(),
      interrupt: vi.fn(() => "cancelled" as const),
    };
    const focus = vi.fn();
    const server = await createIslandControlServer({ sessionId: `test-${Date.now()}`, session, focus });
    try {
      expect(server.capabilities).toEqual(["abort", "steer", "follow_up", "focus"]);
      expect(await request(server.endpoint, { token: "wrong", command: "abort" })).toMatchObject({ ok: false, error: "unauthorized" });
      expect(await request(server.endpoint, { token: server.token, command: "steer", message: "change course" })).toEqual({ ok: true });
      expect(await request(server.endpoint, { token: server.token, command: "follow_up", message: "next task" })).toEqual({ ok: true });
      expect(await request(server.endpoint, { token: server.token, command: "focus" })).toEqual({ ok: true });
      expect(await request(server.endpoint, { token: server.token, command: "abort" })).toMatchObject({ ok: true, result: "cancelled" });
      expect(session.steer).toHaveBeenCalledWith("change course");
      expect(session.followUp).toHaveBeenCalledWith("next task");
      expect(session.interrupt).toHaveBeenCalledOnce();
      expect(focus).toHaveBeenCalledOnce();
    } finally {
      await server.close();
    }
  });
});
