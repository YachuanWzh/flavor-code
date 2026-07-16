import { expect, it, vi } from "vitest";

import { FlavorConfigSchema } from "../../src/config/schema.js";
import { connectSdkMcpClient, type McpSdkDependencies } from "../../src/mcp/sdk.js";

function config(input: Record<string, unknown>) {
  return FlavorConfigSchema.parse({ mcpServers: { test: input } }).mcpServers.test!;
}

function dependencies() {
  const client = {
    connect: vi.fn(async () => undefined),
    listTools: vi.fn(async () => ({ tools: [] })),
    callTool: vi.fn(async () => ({ content: [] })),
    close: vi.fn(async () => undefined),
  };
  const deps: McpSdkDependencies = {
    createClient: vi.fn(() => client),
    createStdioTransport: vi.fn((options) => ({ kind: "stdio", options })),
    createHttpTransport: vi.fn((url, options) => ({ kind: "http", url, options })),
    defaultEnvironment: vi.fn(() => ({ PATH: "inherited-path", HOME: "home" })),
  };
  return { client, deps };
}

it("connects stdio servers in the workspace with inherited and configured environment", async () => {
  const { client, deps } = dependencies();
  const connection = await connectSdkMcpClient({
    name: "local",
    config: config({
      command: "npx",
      args: ["-y", "server"],
      env: { PATH: "configured-path", TOKEN: "secret" },
      cwd: "packages/service",
      timeoutMs: 9_000,
    }),
    workspace: "C:\\workspace",
  }, deps);

  expect(deps.createStdioTransport).toHaveBeenCalledWith({
    command: "npx",
    args: ["-y", "server"],
    env: { PATH: "configured-path", HOME: "home", TOKEN: "secret" },
    cwd: "C:\\workspace\\packages\\service",
    stderr: "ignore",
  });
  expect(client.connect).toHaveBeenCalledWith(
    expect.objectContaining({ kind: "stdio" }),
    { timeout: 9_000 },
  );

  await connection.listTools({ cursor: "next" });
  await connection.callTool(
    { name: "ping", arguments: {} },
    { signal: new AbortController().signal, timeout: 5_000 },
  );
  expect(client.listTools).toHaveBeenCalledWith({ cursor: "next" });
  expect(client.callTool).toHaveBeenCalledWith(
    { name: "ping", arguments: {} },
    undefined,
    expect.objectContaining({ timeout: 5_000 }),
  );
});

it("connects Streamable HTTP servers with configured headers", async () => {
  const { client, deps } = dependencies();
  await connectSdkMcpClient({
    name: "remote",
    config: config({
      url: "https://mcp.example.com/mcp",
      headers: { Authorization: "Bearer secret", "X-Tenant": "flavor" },
    }),
    workspace: process.cwd(),
  }, deps);

  expect(deps.createHttpTransport).toHaveBeenCalledWith(
    new URL("https://mcp.example.com/mcp"),
    { requestInit: { headers: { Authorization: "Bearer secret", "X-Tenant": "flavor" } } },
  );
  expect(client.connect).toHaveBeenCalledWith(
    expect.objectContaining({ kind: "http" }),
    { timeout: 60_000 },
  );
});

it("closes a partially connected SDK client when initialization fails", async () => {
  const { client, deps } = dependencies();
  client.connect.mockRejectedValueOnce(new Error("initialize failed"));

  await expect(connectSdkMcpClient({
    name: "broken",
    config: config({ command: "node" }),
    workspace: process.cwd(),
  }, deps)).rejects.toThrow("initialize failed");

  expect(client.close).toHaveBeenCalledTimes(1);
});
