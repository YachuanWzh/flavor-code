import { createHash } from "node:crypto";
import { z } from "zod";

import type { McpServerConfig } from "../config/schema.js";
import type { ToolDefinition } from "../tools/types.js";
import { message } from "../utils/error.js";

export interface McpRemoteTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export interface McpToolList {
  tools: McpRemoteTool[];
  nextCursor?: string;
}

export interface McpCallResult {
  content?: unknown;
  structuredContent?: unknown;
  isError?: boolean;
  [key: string]: unknown;
}

export interface McpClientConnection {
  listTools(params: { cursor?: string }): Promise<McpToolList>;
  callTool(
    params: { name: string; arguments: Record<string, unknown> },
    options: { signal: AbortSignal; timeout: number },
  ): Promise<McpCallResult>;
  close(): Promise<void>;
}

export interface McpClientFactoryInput {
  name: string;
  config: McpServerConfig;
  workspace: string;
}

export type McpClientFactory = (input: McpClientFactoryInput) => Promise<McpClientConnection>;

export interface ConnectMcpServersOptions {
  servers: Readonly<Record<string, McpServerConfig>>;
  workspace: string;
  clientFactory: McpClientFactory;
}

export type McpServerStatus = "connecting" | "connected" | "failed" | "disabled";

export interface McpServerSummary {
  name: string;
  transport: "stdio" | "http";
  status: McpServerStatus;
  toolCount: number;
  error?: string;
}

export interface McpManagedTool extends McpRemoteTool {
  generatedName: string;
}

interface ManagedTool {
  remote: McpRemoteTool;
  definition: ToolDefinition<unknown>;
}

interface ManagedServer {
  name: string;
  config: McpServerConfig;
  status: McpServerStatus;
  client?: McpClientConnection;
  tools: ManagedTool[];
  error?: string;
}

export class McpManager {
  readonly #workspace: string;
  readonly #clientFactory: McpClientFactory;
  readonly #servers: Map<string, ManagedServer>;
  #closed = false;

  constructor(options: ConnectMcpServersOptions) {
    this.#workspace = options.workspace;
    this.#clientFactory = options.clientFactory;
    this.#servers = new Map(Object.entries(options.servers).map(([name, config]) => [name, {
      name,
      config,
      status: config.disabled ? "disabled" : "connecting",
      tools: [],
    }]));
  }

  get tools(): readonly ToolDefinition<unknown>[] {
    return [...this.#servers.values()].flatMap((server) =>
      server.status === "connected" ? server.tools.map((tool) => tool.definition) : []);
  }

  get diagnostics(): readonly string[] {
    return [...this.#servers.values()].flatMap((server) => server.status === "failed"
      ? [`MCP server "${server.name}" unavailable: ${server.error ?? "Unknown error"}`]
      : []);
  }

  async initialize(): Promise<void> {
    await Promise.all([...this.#servers.values()].map(async (server) => {
      if (server.status !== "disabled") await this.#connect(server);
    }));
  }

  listServers(): McpServerSummary[] {
    return [...this.#servers.values()]
      .map((server) => this.#summary(server))
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  toolsFor(name: string): McpManagedTool[] {
    const server = this.#requireServer(name);
    return server.tools.map(({ remote, definition }) => ({ ...remote, generatedName: definition.name }));
  }

  async reconnect(name: string): Promise<McpServerSummary> {
    this.#assertOpen();
    const server = this.#requireServer(name);
    if (server.status === "disabled") return this.#summary(server);
    await this.#disconnect(server);
    await this.#connect(server);
    return this.#summary(server);
  }

  async setEnabled(name: string, enabled: boolean): Promise<McpServerSummary> {
    this.#assertOpen();
    const server = this.#requireServer(name);
    server.config.disabled = !enabled;
    if (!enabled) {
      await this.#disconnect(server);
      server.status = "disabled";
      server.tools = [];
      delete server.error;
    } else if (server.status === "disabled") {
      await this.#connect(server);
    }
    return this.#summary(server);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const results = await Promise.allSettled([...this.#servers.values()].map((server) => this.#disconnect(server)));
    const failures = results
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason);
    if (failures.length > 0) throw new AggregateError(failures, "Failed to close MCP clients");
  }

  async #connect(server: ManagedServer): Promise<void> {
    server.status = "connecting";
    server.tools = [];
    delete server.error;
    let client: McpClientConnection | undefined;
    try {
      client = await this.#clientFactory({ name: server.name, config: server.config, workspace: this.#workspace });
      const remoteTools = await listAllTools(client);
      const names = new Set<string>();
      const tools = remoteTools.map((remote) => {
        const definition = createMcpToolDefinition(server.name, server.config.timeoutMs, client!, remote);
        if (names.has(definition.name)) throw new Error(`duplicate generated tool name: ${definition.name}`);
        names.add(definition.name);
        return { remote, definition };
      });
      server.client = client;
      server.tools = tools;
      server.status = "connected";
    } catch (error) {
      if (client !== undefined) {
        try { await client.close(); }
        catch { /* Preserve the connection or discovery error. */ }
      }
      delete server.client;
      server.tools = [];
      server.status = "failed";
      server.error = message(error);
    }
  }

  async #disconnect(server: ManagedServer): Promise<void> {
    const client = server.client;
    delete server.client;
    server.tools = [];
    if (client !== undefined) await client.close();
  }

  #summary(server: ManagedServer): McpServerSummary {
    return {
      name: server.name,
      transport: "command" in server.config ? "stdio" : "http",
      status: server.status,
      toolCount: server.tools.length,
      ...(server.error === undefined ? {} : { error: server.error }),
    };
  }

  #requireServer(name: string): ManagedServer {
    const server = this.#servers.get(name);
    if (server === undefined) throw new Error(`MCP server "${name}" not found`);
    return server;
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("MCP manager is closed");
  }
}

export async function connectMcpServers(options: ConnectMcpServersOptions): Promise<McpManager> {
  const manager = new McpManager(options);
  await manager.initialize();
  return manager;
}

async function listAllTools(client: McpClientConnection): Promise<McpRemoteTool[]> {
  const tools: McpRemoteTool[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.listTools(cursor === undefined ? {} : { cursor });
    tools.push(...page.tools);
    cursor = page.nextCursor;
  } while (cursor !== undefined && cursor !== "");
  return tools;
}

function createMcpToolDefinition(
  serverName: string,
  timeoutMs: number,
  client: McpClientConnection,
  remote: McpRemoteTool,
): ToolDefinition<unknown> {
  if (remote.name.length === 0) throw new Error("MCP tool name must not be empty");
  if (!isRecord(remote.inputSchema)) throw new Error(`MCP tool "${remote.name}" has no JSON object input schema`);
  const inputSchema = z.fromJSONSchema(
    remote.inputSchema as Parameters<typeof z.fromJSONSchema>[0],
  );
  return {
    name: mcpToolName(serverName, remote.name),
    description: remote.description ?? `MCP tool ${serverName}/${remote.name}`,
    inputSchema,
    agents: ["main"],
    modelInputSchema: remote.inputSchema,
    modelStrict: false,
    paths: () => [],
    summarize: () => `${serverName}/${remote.name}`,
    execute: async (input, signal) => {
      if (!isRecord(input)) throw new Error(`MCP tool "${remote.name}" arguments must be an object`);
      const result = await client.callTool(
        { name: remote.name, arguments: input },
        { signal, timeout: timeoutMs },
      );
      if (result.isError === true) {
        throw new Error(`MCP tool ${serverName}/${remote.name} failed: ${mcpErrorText(result.content)}`);
      }
      return result;
    },
  };
}

export function mcpToolName(serverName: string, remoteName: string): string {
  const prefix = `mcp__${serverName}__`;
  const safe = remoteName.replace(/[^A-Za-z0-9_-]/g, "_") || "tool";
  const direct = `${prefix}${safe}`;
  if (direct.length <= 64 && safe === remoteName) return direct;
  const suffix = `__${createHash("sha256").update(remoteName).digest("hex").slice(0, 8)}`;
  return `${prefix}${safe.slice(0, Math.max(1, 64 - prefix.length - suffix.length))}${suffix}`;
}

function mcpErrorText(content: unknown): string {
  if (Array.isArray(content)) {
    const text = content.flatMap((item) => isRecord(item) && typeof item.text === "string" ? [item.text] : []);
    if (text.length > 0) return text.join("\n");
  }
  try { return JSON.stringify(content) ?? String(content); }
  catch { return String(content); }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
