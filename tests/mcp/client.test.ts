import { describe, expect, it, vi } from "vitest";

import { FlavorConfigSchema } from "../../src/config/schema.js";
import {
  connectMcpServers,
  type McpClientConnection,
  type McpClientFactory,
} from "../../src/mcp/client.js";

function servers(input: Record<string, unknown>) {
  return FlavorConfigSchema.parse({ mcpServers: input }).mcpServers;
}

function fakeClient(overrides: Partial<McpClientConnection> = {}): McpClientConnection {
  return {
    listTools: vi.fn(async () => ({ tools: [] })),
    callTool: vi.fn(async () => ({ content: [] })),
    close: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe("connectMcpServers", () => {
  it("discovers every tool page and exposes namespaced native tools", async () => {
    const listTools = vi.fn()
      .mockResolvedValueOnce({
        tools: [{
          name: "search.docs",
          description: "Search documentation",
          inputSchema: {
            type: "object",
            properties: { query: { type: "string" } },
            required: ["query"],
          },
        }],
        nextCursor: "next-page",
      })
      .mockResolvedValueOnce({
        tools: [{
          name: "get_page",
          inputSchema: { type: "object", properties: { id: { type: "integer" } } },
        }],
      });
    const client = fakeClient({ listTools });
    const factory = vi.fn(async () => client);

    const manager = await connectMcpServers({
      servers: servers({ docs: { command: "node", args: ["server.js"] } }),
      workspace: process.cwd(),
      clientFactory: factory,
    });

    expect(listTools).toHaveBeenNthCalledWith(1, {});
    expect(listTools).toHaveBeenNthCalledWith(2, { cursor: "next-page" });
    expect(manager.tools.map((tool) => tool.name)).toEqual([
      "mcp__docs__search_docs__67ba9783",
      "mcp__docs__get_page",
    ]);
    expect(manager.tools[0]?.description).toContain("Search documentation");
    expect(manager.tools[0]?.modelInputSchema).toEqual({
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    });
    expect(manager.tools[0]?.modelStrict).toBe(false);
    expect(manager.diagnostics).toEqual([]);
  });

  it("forwards validated arguments, the abort signal, and the configured timeout", async () => {
    const callTool = vi.fn(async () => ({
      content: [{ type: "text", text: "found" }],
      structuredContent: { count: 1 },
    }));
    const client = fakeClient({
      listTools: vi.fn(async () => ({
        tools: [{
          name: "search",
          description: "Search",
          inputSchema: {
            type: "object",
            properties: { query: { type: "string" } },
            required: ["query"],
          },
        }],
      })),
      callTool,
    });
    const manager = await connectMcpServers({
      servers: servers({ docs: { url: "https://mcp.example.com/mcp", timeoutMs: 12_345 } }),
      workspace: process.cwd(),
      clientFactory: async () => client,
    });
    const controller = new AbortController();

    const result = await manager.tools[0]!.execute({ query: "MCP" }, controller.signal);

    expect(callTool).toHaveBeenCalledWith(
      { name: "search", arguments: { query: "MCP" } },
      { signal: controller.signal, timeout: 12_345 },
    );
    expect(result).toMatchObject({ structuredContent: { count: 1 } });
  });

  it("turns MCP error results into tool execution failures", async () => {
    const client = fakeClient({
      listTools: vi.fn(async () => ({
        tools: [{ name: "fail", inputSchema: { type: "object" } }],
      })),
      callTool: vi.fn(async () => ({
        isError: true,
        content: [{ type: "text", text: "remote exploded" }],
      })),
    });
    const manager = await connectMcpServers({
      servers: servers({ broken: { command: "node" } }),
      workspace: process.cwd(),
      clientFactory: async () => client,
    });

    await expect(manager.tools[0]!.execute({}, new AbortController().signal))
      .rejects.toThrow("MCP tool broken/fail failed: remote exploded");
  });

  it("keeps healthy servers when another server cannot connect", async () => {
    const healthy = fakeClient({
      listTools: vi.fn(async () => ({
        tools: [{ name: "ping", inputSchema: { type: "object" } }],
      })),
    });
    const factory: McpClientFactory = vi.fn(async ({ name }) => {
      if (name === "bad") throw new Error("connection refused");
      return healthy;
    });

    const manager = await connectMcpServers({
      servers: servers({
        bad: { command: "missing" },
        good: { url: "https://mcp.example.com/mcp" },
        off: { command: "ignored", disabled: true },
      }),
      workspace: process.cwd(),
      clientFactory: factory,
    });

    expect(factory).toHaveBeenCalledTimes(2);
    expect(manager.tools.map((tool) => tool.name)).toEqual(["mcp__good__ping"]);
    expect(manager.diagnostics).toEqual([
      'MCP server "bad" unavailable: connection refused',
    ]);
  });

  it("closes a client whose discovery fails and closes healthy clients only once", async () => {
    const failed = fakeClient({ listTools: vi.fn(async () => { throw new Error("bad schema"); }) });
    const healthy = fakeClient();
    const manager = await connectMcpServers({
      servers: servers({ failed: { command: "node" }, healthy: { command: "node" } }),
      workspace: process.cwd(),
      clientFactory: async ({ name }) => name === "failed" ? failed : healthy,
    });

    expect(failed.close).toHaveBeenCalledTimes(1);
    await manager.close();
    await manager.close();
    expect(healthy.close).toHaveBeenCalledTimes(1);
  });

  it("reports per-server state and exposes remote tool metadata", async () => {
    const manager = await connectMcpServers({
      servers: servers({
        docs: { url: "https://mcp.example.com/mcp" },
        off: { command: "node", disabled: true },
        broken: { command: "missing" },
      }),
      workspace: process.cwd(),
      clientFactory: async ({ name }) => {
        if (name === "broken") throw new Error("spawn ENOENT");
        return fakeClient({ listTools: vi.fn(async () => ({ tools: [{
          name: "search", description: "Search docs", inputSchema: { type: "object", properties: { query: { type: "string" } } },
        }] })) });
      },
    });

    expect(manager.listServers()).toEqual([
      { name: "broken", transport: "stdio", status: "failed", toolCount: 0, error: "spawn ENOENT" },
      { name: "docs", transport: "http", status: "connected", toolCount: 1 },
      { name: "off", transport: "stdio", status: "disabled", toolCount: 0 },
    ]);
    expect(manager.toolsFor("docs")).toEqual([expect.objectContaining({
      name: "search", generatedName: "mcp__docs__search", description: "Search docs",
    })]);
  });

  it("disables, enables, and reconnects servers while replacing their tools", async () => {
    const first = fakeClient({ listTools: vi.fn(async () => ({
      tools: [{ name: "first", inputSchema: { type: "object" } }],
    })) });
    const second = fakeClient({ listTools: vi.fn(async () => ({
      tools: [{ name: "second", inputSchema: { type: "object" } }],
    })) });
    const third = fakeClient({ listTools: vi.fn(async () => ({
      tools: [{ name: "third", inputSchema: { type: "object" } }],
    })) });
    const factory = vi.fn()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second)
      .mockResolvedValueOnce(third);
    const manager = await connectMcpServers({
      servers: servers({ docs: { command: "node" } }), workspace: process.cwd(), clientFactory: factory,
    });

    expect(manager.tools.map((tool) => tool.name)).toEqual(["mcp__docs__first"]);
    await manager.setEnabled("docs", false);
    expect(first.close).toHaveBeenCalledTimes(1);
    expect(manager.tools).toEqual([]);
    expect(manager.listServers()[0]).toMatchObject({ status: "disabled", toolCount: 0 });

    await manager.setEnabled("docs", true);
    expect(manager.tools.map((tool) => tool.name)).toEqual(["mcp__docs__second"]);
    await manager.reconnect("docs");
    expect(second.close).toHaveBeenCalledTimes(1);
    expect(manager.tools.map((tool) => tool.name)).toEqual(["mcp__docs__third"]);
  });
});
