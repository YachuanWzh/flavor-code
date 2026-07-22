import { join } from "node:path";

import { McpServerConfigSchema, McpServerNameSchema, type McpServerConfig, type McpServerConfigInput } from "../config/schema.js";
import { readRecoverableFile, updateProtectedFile } from "../config/protected-file.js";

type ConfigObject = Record<string, unknown>;

export interface ManagedMcpServer {
  name: string;
  transport: "stdio" | "http";
  enabled: boolean;
  config: McpServerConfig;
}

export interface ProjectMcpConfigManagerLike {
  readonly path: string;
  list(): Promise<ManagedMcpServer[]>;
  create(name: string, config: McpServerConfigInput): Promise<ManagedMcpServer>;
  update(originalName: string, name: string, config: McpServerConfigInput): Promise<ManagedMcpServer>;
  setEnabled(name: string, enabled: boolean): Promise<ManagedMcpServer>;
  delete(name: string): Promise<void>;
}

export class ProjectMcpConfigManager implements ProjectMcpConfigManagerLike {
  readonly path: string;

  constructor(workspace: string) {
    this.path = join(workspace, ".flavor", "flavor.json");
  }

  async list(): Promise<ManagedMcpServer[]> {
    const document = await readRecoverableFile(this.path, (raw) => parseDocument(this.path, raw));
    return parseServers(this.path, document?.value["mcpServers"]);
  }

  async create(name: string, config: McpServerConfigInput): Promise<ManagedMcpServer> {
    const validName = McpServerNameSchema.parse(name);
    const validConfig = McpServerConfigSchema.parse(config);
    await this.#mutate((servers) => {
      if (servers[validName] !== undefined) throw new Error(`MCP service "${validName}" already exists`);
      servers[validName] = validConfig;
    });
    return managedServer(validName, validConfig);
  }

  async update(originalName: string, name: string, config: McpServerConfigInput): Promise<ManagedMcpServer> {
    const validOriginal = McpServerNameSchema.parse(originalName);
    const validName = McpServerNameSchema.parse(name);
    const parsedConfig = McpServerConfigSchema.parse(config);
    let persistedConfig = parsedConfig;
    await this.#mutate((servers) => {
      const current = servers[validOriginal];
      if (current === undefined) throw new Error(`MCP service "${validOriginal}" not found`);
      if (validName !== validOriginal && servers[validName] !== undefined) {
        throw new Error(`MCP service "${validName}" already exists`);
      }
      const sameTransport = ("command" in current && "command" in config)
        || ("url" in current && "url" in config);
      persistedConfig = sameTransport
        ? McpServerConfigSchema.parse({ ...current, ...config })
        : parsedConfig;
      delete servers[validOriginal];
      servers[validName] = persistedConfig;
    });
    return managedServer(validName, persistedConfig);
  }

  async setEnabled(name: string, enabled: boolean): Promise<ManagedMcpServer> {
    const validName = McpServerNameSchema.parse(name);
    let next: McpServerConfig | undefined;
    await this.#mutate((servers) => {
      const current = servers[validName];
      if (current === undefined) throw new Error(`MCP service "${validName}" not found`);
      next = McpServerConfigSchema.parse({ ...current, disabled: !enabled });
      servers[validName] = next;
    });
    return managedServer(validName, next!);
  }

  async delete(name: string): Promise<void> {
    const validName = McpServerNameSchema.parse(name);
    await this.#mutate((servers) => {
      if (servers[validName] === undefined) throw new Error(`MCP service "${validName}" not found`);
      delete servers[validName];
    });
  }

  async #mutate(update: (servers: Record<string, McpServerConfig>) => void): Promise<void> {
    await updateProtectedFile<ConfigObject>({
      path: this.path,
      decode: (raw) => parseDocument(this.path, raw),
      encode: (value) => `${JSON.stringify(value, null, 2)}\n`,
      update: (current) => {
        const document = { ...(current ?? {}) };
        const servers = Object.fromEntries(parseServers(this.path, document["mcpServers"])
          .map((server) => [server.name, server.config]));
        update(servers);
        document["mcpServers"] = servers;
        return document;
      },
    });
  }
}

function parseDocument(path: string, raw: string): ConfigObject {
  const value: unknown = JSON.parse(raw);
  if (!isRecord(value)) throw new Error(`Configuration file ${path} must contain a JSON object`);
  return value;
}

function parseServers(path: string, value: unknown): ManagedMcpServer[] {
  if (value === undefined) return [];
  if (!isRecord(value)) throw new Error(`Configuration field mcpServers in ${path} must be an object`);
  return Object.entries(value).map(([name, config]) => {
    try {
      return managedServer(McpServerNameSchema.parse(name), McpServerConfigSchema.parse(config));
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`Invalid MCP service "${name}" in ${path}: ${reason}`);
    }
  }).sort((left, right) => left.name.localeCompare(right.name));
}

function managedServer(name: string, config: McpServerConfig): ManagedMcpServer {
  return {
    name,
    transport: "command" in config ? "stdio" : "http",
    enabled: !config.disabled,
    config,
  };
}

function isRecord(value: unknown): value is ConfigObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
