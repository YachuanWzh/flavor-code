import { homedir } from "node:os";
import { join } from "node:path";
import type { Command } from "commander";

import { configPathSegments, type FlavorConfig } from "./schema.js";

export interface ConfigCliResult {
  config: FlavorConfig;
  sources: string[];
}

export interface ConfigCliDependencies {
  load?(options: { cwd: string; home: string }): Promise<ConfigCliResult>;
  redact?(config: unknown): Promise<unknown> | unknown;
  setValue?(cwd: string, home: string, key: string, value: unknown): Promise<string>;
  unsetValue?(cwd: string, key: string): Promise<string>;
  cwd?(): string;
  home?(): string;
  write?(text: string): void;
}

export function registerConfigCommands(
  program: Command,
  dependencies: ConfigCliDependencies = {},
): void {
  const cwd = dependencies.cwd ?? (() => process.cwd());
  const home = dependencies.home ?? homedir;
  const write = dependencies.write ?? ((text: string) => process.stdout.write(text));
  const load = dependencies.load ?? (async ({ cwd: dir, home: homeDir }: { cwd: string; home: string }) => {
    const { loadConfig } = await import("./load.js");
    return loadConfig({ cwd: dir, home: homeDir });
  });
  const redactSecrets = dependencies.redact ?? (async (config: unknown): Promise<unknown> => {
    const { redactConfig } = await import("./load.js");
    return redactConfig(config);
  });
  const setValue = dependencies.setValue ?? (async (dir: string, homeDir: string, key: string, value: unknown) => {
    const { setProjectConfigValue } = await import("./load.js");
    return setProjectConfigValue(dir, homeDir, key, value);
  });
  const unsetValue = dependencies.unsetValue ?? (async (dir: string, key: string) => {
    const { unsetProjectConfigValue } = await import("./load.js");
    return unsetProjectConfigValue(dir, key);
  });

  const config = program.command("config").description("Inspect and edit Flavor configuration");

  config.command("list", { isDefault: true })
    .description("Print the effective (redacted) configuration")
    .option("--json", "print only the redacted JSON object")
    .option("--sources", "list the configuration files that were merged")
    .action(async (options: { json?: boolean; sources?: boolean }) => {
      const loaded = await load({ cwd: cwd(), home: home() });
      const redacted = await redactSecrets(loaded.config);
      if (options.json) {
        write(`${JSON.stringify(redacted, null, 2)}\n`);
        return;
      }
      if (options.sources) {
        if (loaded.sources.length === 0) write("No configuration files found; using defaults.\n");
        else for (const source of loaded.sources) write(`${source}\n`);
        return;
      }
      write(`Sources: ${loaded.sources.length > 0 ? loaded.sources.join(", ") : "(defaults only)"}\n`);
      write(`${JSON.stringify(redacted, null, 2)}\n`);
    });

  config.command("get <key>")
    .description("Print one configuration value by dot path, e.g. context.windowTokens")
    .action(async (key: string) => {
      const segments = configPathSegments(key);
      const loaded = await load({ cwd: cwd(), home: home() });
      const redacted = await redactSecrets(loaded.config) as Record<string, unknown>;
      const found = dig(redacted, segments);
      if (!found.found) throw new Error(`No such configuration key: ${key}`);
      const value = found.value;
      write(typeof value === "string" ? `${value}\n` : `${JSON.stringify(value, null, 2)}\n`);
    });

  config.command("set <key> <value>")
    .description("Set one project configuration value (JSON literals are parsed, e.g. 50, true, [\"a\"]")
    .action(async (key: string, rawValue: string) => {
      const path = await setValue(cwd(), home(), key, parseConfigValue(rawValue));
      write(`Set ${key} in ${path}\n`);
    });

  config.command("unset <key>")
    .description("Remove one key from the project configuration")
    .action(async (key: string) => {
      const path = await unsetValue(cwd(), key);
      write(`Removed ${key} from ${path}\n`);
    });

  config.command("path")
    .description("Print the project and global configuration paths")
    .action(() => {
      write(`project: ${join(cwd(), ".flavor", "flavor.json")}\n`);
      write(`global:  ${join(home(), ".flavor-code", "flavor.json")}\n`);
    });
}

function dig(root: unknown, segments: readonly string[]): { found: boolean; value?: unknown } {
  let cursor = root;
  for (const segment of segments) {
    if (typeof cursor === "object" && cursor !== null && !Array.isArray(cursor) && segment in cursor) {
      cursor = (cursor as Record<string, unknown>)[segment];
    } else {
      return { found: false };
    }
  }
  return { found: true, value: cursor };
}

function parseConfigValue(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}
