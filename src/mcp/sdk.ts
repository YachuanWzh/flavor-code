import { resolve } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  getDefaultEnvironment,
  StdioClientTransport,
  type StdioServerParameters,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  StreamableHTTPClientTransport,
  type StreamableHTTPClientTransportOptions,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import type { McpClientConnection, McpClientFactoryInput, McpCallResult, McpToolList } from "./client.js";

interface SdkClientLike {
  connect(transport: unknown, options?: { timeout?: number }): Promise<void>;
  listTools(params?: { cursor?: string }): Promise<McpToolList>;
  callTool(
    params: { name: string; arguments?: Record<string, unknown> },
    resultSchema?: undefined,
    options?: { signal?: AbortSignal; timeout?: number },
  ): Promise<McpCallResult>;
  close(): Promise<void>;
}

export interface McpSdkDependencies {
  createClient(): SdkClientLike;
  createStdioTransport(options: StdioServerParameters): unknown;
  createHttpTransport(url: URL, options: StreamableHTTPClientTransportOptions): unknown;
  defaultEnvironment(): Record<string, string>;
}

const DEFAULT_DEPENDENCIES: McpSdkDependencies = {
  createClient: () => new Client({ name: "flavor-code", version: "0.8.0" }) as unknown as SdkClientLike,
  createStdioTransport: (options) => new StdioClientTransport(options),
  createHttpTransport: (url, options) => new StreamableHTTPClientTransport(url, options),
  defaultEnvironment: getDefaultEnvironment,
};

export async function connectSdkMcpClient(
  input: McpClientFactoryInput,
  dependencies: McpSdkDependencies = DEFAULT_DEPENDENCIES,
): Promise<McpClientConnection> {
  const client = dependencies.createClient();
  const config = input.config;
  const transport = "command" in config
    ? dependencies.createStdioTransport({
      command: config.command,
      args: [...config.args],
      env: { ...dependencies.defaultEnvironment(), ...config.env },
      cwd: resolve(input.workspace, config.cwd ?? "."),
      // MCP servers frequently log startup banners to stderr. Inheriting that
      // stream corrupts Ink's input area, so connection errors are surfaced
      // through McpManager diagnostics instead.
      stderr: "ignore",
    })
    : dependencies.createHttpTransport(new URL(config.url), {
      requestInit: { headers: { ...config.headers } },
    });

  try {
    await client.connect(transport, { timeout: config.timeoutMs });
  } catch (error) {
    try { await client.close(); }
    catch { /* Preserve the initialization failure. */ }
    throw error;
  }

  return {
    listTools: (params) => client.listTools(params),
    callTool: (params, options) => client.callTool(params, undefined, options),
    close: () => client.close(),
  };
}
