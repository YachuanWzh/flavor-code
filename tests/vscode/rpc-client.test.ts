import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";

import { FlavorRpcClient } from "../../extensions/vscode/src/rpc-client.js";

describe("FlavorRpcClient", () => {
  it("correlates responses and streams runtime events", async () => {
    const fromServer = new PassThrough();
    const toServer = new PassThrough();
    const client = new FlavorRpcClient({ input: fromServer, output: toServer });
    const events: unknown[] = [];
    client.onEvent((event) => events.push(event));
    const written: string[] = [];
    toServer.on("data", (chunk) => written.push(chunk.toString("utf8")));

    const response = client.request({ type: "steer", message: "focus tests" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const command = JSON.parse(written.join("").trim()) as { id: string };
    fromServer.write(`${JSON.stringify({ id: command.id, type: "response", success: true, data: { steering: ["focus tests"] } })}\n`);
    fromServer.write('{"type":"event","event":{"type":"text","text":"working"}}\n');

    await expect(response).resolves.toEqual({ steering: ["focus tests"] });
    expect(events).toEqual([{ type: "text", text: "working" }]);
    await client.dispose();
  });

  it("rejects pending requests when the transport closes", async () => {
    const input = new PassThrough();
    const client = new FlavorRpcClient({ input, output: new PassThrough() });
    const pending = client.request({ type: "get_state" });
    input.end();
    await expect(pending).rejects.toThrow(/closed/i);
  });
});
