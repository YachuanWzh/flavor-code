import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "dotenv";
import { FlavorConfigSchema, type FlavorConfig } from "./schema.js";

type ConfigObject = Record<string, unknown>;

export interface LoadConfigOptions {
  cwd: string;
  home: string;
  cli?: ConfigObject;
  environment?: Record<string, string | undefined>;
}

export interface LoadedConfig {
  config: FlavorConfig;
  sources: string[];
}

async function readJsonIfPresent(path: string): Promise<ConfigObject | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!isPlainObject(parsed)) {
      throw new Error(`Configuration file ${path} must contain a JSON object`);
    }
    return parsed;
  } catch (error) {
    if (isMissingFileError(error)) {
      return undefined;
    }
    throw error;
  }
}

async function readTextIfPresent(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isMissingFileError(error)) {
      return undefined;
    }
    throw error;
  }
}

function isMissingFileError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function isPlainObject(value: unknown): value is ConfigObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mergeConfig(base: ConfigObject, override: ConfigObject): ConfigObject {
  const result: ConfigObject = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) {
      continue;
    }
    const current = result[key];
    result[key] =
      isPlainObject(current) && isPlainObject(value)
        ? mergeConfig(current, value)
        : value;
  }
  return result;
}

function interpolate(value: unknown, environment: Record<string, string | undefined>): unknown {
  if (typeof value === "string") {
    return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (match, name: string) =>
      environment[name] === undefined ? match : environment[name],
    );
  }
  if (Array.isArray(value)) {
    return value.map((item) => interpolate(item, environment));
  }
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, interpolate(item, environment)]),
    );
  }
  return value;
}

export async function loadConfig(options: LoadConfigOptions): Promise<LoadedConfig> {
  const globalPath = join(options.home, ".flavor-code", "flavor.json");
  const envPath = join(options.cwd, ".env");
  const projectPath = join(options.cwd, ".flavor", "flavor.json");
  const sources: string[] = [];

  const globalConfig = await readJsonIfPresent(globalPath);
  if (globalConfig) sources.push(globalPath);

  const envText = await readTextIfPresent(envPath);
  const projectEnvironment = envText === undefined ? {} : parse(envText);
  if (envText !== undefined) sources.push(envPath);

  // Populate process.env with .env values so they are visible to module-level
  // consumers (OAUTH_DEFAULTS, etc.). Never override an already-set env var.
  for (const [key, value] of Object.entries(projectEnvironment)) {
    if (value !== undefined && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }

  const projectConfig = await readJsonIfPresent(projectPath);
  if (projectConfig) sources.push(projectPath);

  const merged = mergeConfig(
    mergeConfig(globalConfig ?? {}, projectConfig ?? {}),
    options.cli ?? {},
  );
  const interpolated = interpolate(merged, {
    ...(options.environment ?? process.env),
    ...projectEnvironment,
  });

  return {
    config: FlavorConfigSchema.parse(interpolated),
    sources,
  };
}

const SECRET_FIELDS = new Set(["apiKey", "authorization", "token"]);

export function redactConfig(config: unknown): unknown {
  if (Array.isArray(config)) {
    return config.map((item) => redactConfig(item));
  }
  if (!isPlainObject(config)) {
    return config;
  }
  return Object.fromEntries(
    Object.entries(config).map(([key, value]) => [
      key,
      SECRET_FIELDS.has(key) ? "[redacted]" : redactConfig(value),
    ]),
  );
}
