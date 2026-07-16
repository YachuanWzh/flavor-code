import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

import { FlavorConfigSchema } from "../../src/config/schema.js";
import { connectSdkMcpClient } from "../../src/mcp/sdk.js";

it("discovers and calls a real stdio MCP server", async () => {
  const fixture = fileURLToPath(new URL("./fixtures/echo-server.mjs", import.meta.url));
  const config = FlavorConfigSchema.parse({
    mcpServers: {
      echo: { command: process.execPath, args: [fixture], timeoutMs: 10_000 },
    },
  }).mcpServers.echo!;
  const connection = await connectSdkMcpClient({
    name: "echo",
    config,
    workspace: process.cwd(),
  });

  try {
    await expect(connection.listTools({})).resolves.toMatchObject({
      tools: [expect.objectContaining({ name: "echo" })],
    });
    await expect(connection.callTool(
      { name: "echo", arguments: { value: "hello MCP" } },
      { signal: new AbortController().signal, timeout: 10_000 },
    )).resolves.toMatchObject({
      content: [{ type: "text", text: "hello MCP" }],
      structuredContent: { value: "hello MCP" },
    });
  } finally {
    await connection.close();
  }
}, 20_000);
