import type { Command } from "commander";

import type { McpServerConfigInput } from "../config/schema.js";
import { ProjectMcpConfigManager } from "./config-manager.js";

interface McpCliManager {
  readonly path: string;
  list(): Promise<readonly { name: string; transport: string; enabled: boolean }[]>;
  create(name: string, config: McpServerConfigInput): Promise<unknown>;
  update(originalName: string, name: string, config: McpServerConfigInput): Promise<unknown>;
  setEnabled(name: string, enabled: boolean): Promise<unknown>;
  delete(name: string): Promise<unknown>;
}

export interface McpCliDependencies {
  open(): McpCliManager;
  write(text: string): void;
}

interface ConfigOptions {
  command?: string;
  url?: string;
  arg?: string[];
  env?: string[];
  header?: string[];
  cwd?: string;
  timeout?: number;
}

export function registerMcpCommands(program: Command, dependencies?: Partial<McpCliDependencies>): void {
  const deps: McpCliDependencies = {
    open: dependencies?.open ?? (() => new ProjectMcpConfigManager(process.cwd())),
    write: dependencies?.write ?? ((text) => process.stdout.write(text)),
  };
  const mcp = program.command("mcp").description("Manage project MCP service configurations");

  mcp.command("list", { isDefault: true }).option("--json", "print JSON").action(async (options: { json?: boolean }) => {
    const services = await deps.open().list();
    if (options.json) deps.write(`${JSON.stringify(services, null, 2)}\n`);
    else if (services.length === 0) deps.write("No project MCP services configured.\n");
    else for (const service of services) {
      deps.write(`${service.enabled ? "on " : "off"}  ${service.name}  ${service.transport}\n`);
    }
  });

  addConfigCommand(mcp.command("add <name>").description("Add a project MCP service"))
    .action(async (name: string, options: ConfigOptions) => {
      await deps.open().create(name, configFromOptions(options));
      deps.write(`Added MCP service ${name}.\n`);
    });

  addConfigCommand(mcp.command("update <name>").description("Replace a project MCP service configuration"))
    .option("--rename <name>", "rename the service")
    .action(async (name: string, options: ConfigOptions & { rename?: string }) => {
      await deps.open().update(name, options.rename ?? name, configFromOptions(options));
      deps.write(`Updated MCP service ${options.rename ?? name}.\n`);
    });

  for (const enabled of [true, false]) {
    const action = enabled ? "enable" : "disable";
    mcp.command(`${action} <name>`).description(`${enabled ? "Enable" : "Disable"} a project MCP service`)
      .action(async (name: string) => {
        await deps.open().setEnabled(name, enabled);
        deps.write(`${enabled ? "Enabled" : "Disabled"} MCP service ${name}.\n`);
      });
  }

  mcp.command("delete <name>").description("Delete a project MCP service").action(async (name: string) => {
    await deps.open().delete(name);
    deps.write(`Deleted MCP service ${name}.\n`);
  });
  mcp.command("path").description("Print the project MCP configuration path").action(() => {
    deps.write(`${deps.open().path}\n`);
  });
}

function addConfigCommand(command: Command): Command {
  return command
    .option("--command <program>", "stdio executable")
    .option("--url <url>", "Streamable HTTP endpoint")
    .option("--arg <value>", "stdio argument; repeatable", collect, [])
    .option("--env <KEY=VALUE>", "stdio environment entry; repeatable", collect, [])
    .option("--header <KEY=VALUE>", "HTTP header; repeatable", collect, [])
    .option("--cwd <path>", "stdio working directory")
    .option("--timeout <ms>", "request timeout in milliseconds", parseTimeout);
}

function configFromOptions(options: ConfigOptions): McpServerConfigInput {
  if ((options.command === undefined) === (options.url === undefined)) {
    throw new Error("Specify exactly one transport with --command or --url");
  }
  if (options.command !== undefined) {
    if ((options.header?.length ?? 0) > 0) throw new Error("--header is available only with --url");
    return {
      command: options.command,
      ...(options.arg?.length ? { args: options.arg } : {}),
      ...(options.env?.length ? { env: keyValueRecord(options.env, "environment") } : {}),
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.timeout === undefined ? {} : { timeoutMs: options.timeout }),
    };
  }
  if ((options.arg?.length ?? 0) > 0 || (options.env?.length ?? 0) > 0 || options.cwd !== undefined) {
    throw new Error("--arg, --env, and --cwd are available only with --command");
  }
  return {
    url: options.url!,
    ...(options.header?.length ? { headers: keyValueRecord(options.header, "header") } : {}),
    ...(options.timeout === undefined ? {} : { timeoutMs: options.timeout }),
  };
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function parseTimeout(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 100) throw new Error("--timeout must be an integer of at least 100ms");
  return parsed;
}

function keyValueRecord(entries: readonly string[], label: string): Record<string, string> {
  return Object.fromEntries(entries.map((entry) => {
    const separator = entry.indexOf("=");
    if (separator <= 0) throw new Error(`Invalid ${label} entry "${entry}"; use KEY=VALUE`);
    return [entry.slice(0, separator), entry.slice(separator + 1)];
  }));
}
