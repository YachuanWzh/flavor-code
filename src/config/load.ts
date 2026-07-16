import { mkdir, readFile, writeFile } from "node:fs/promises";
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
    const result = value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (match, name: string) =>
      environment[name] === undefined ? match : environment[name],
    );
    // If the entire value is an unresolved template reference, drop it so
    // optional fields like baseURL fall back to their defaults instead of
    // failing URL validation with the literal "${...}" string.
    if (/^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(value) && result === value) {
      return undefined;
    }
    return result;
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

const FLAVOR_ENV_VARS = [
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "OAUTH_AUTHORIZATION_URL",
  "OAUTH_TOKEN_URL",
  "OAUTH_CALLBACK_HOST",
  "OAUTH_CLIENT_ID",
  "OAUTH_SCOPE",
] as const;

async function seedGlobalEnv(globalEnvPath: string): Promise<void> {
  try {
    // Skip if global .env already exists — never overwrite user settings.
    await readFile(globalEnvPath, "utf8");
    return;
  } catch (error) {
    if (!isMissingFileError(error)) return;
  }
  const lines: string[] = [];
  for (const key of FLAVOR_ENV_VARS) {
    const value = process.env[key];
    if (value !== undefined && value !== "") {
      lines.push(`${key}=${value}`);
    }
  }
  if (lines.length === 0) return;
  try {
    await mkdir(join(globalEnvPath, ".."), { recursive: true });
    await writeFile(globalEnvPath, `${lines.join("\n")}\n`, "utf8");
  } catch {
    // Failing to seed the global env is not fatal.
  }
}

export async function loadConfig(options: LoadConfigOptions): Promise<LoadedConfig> {
  const globalPath = join(options.home, ".flavor-code", "flavor.json");
  const globalEnvPath = join(options.home, ".flavor-code", ".env");
  const envPath = join(options.cwd, ".env");
  const projectPath = join(options.cwd, ".flavor", "flavor.json");
  const sources: string[] = [];

  const globalConfig = await readJsonIfPresent(globalPath);
  if (globalConfig) sources.push(globalPath);

  // Load global .env first (lower priority), then project .env (higher priority).
  const globalEnvText = await readTextIfPresent(globalEnvPath);
  const projectEnvText = await readTextIfPresent(envPath);
  const projectEnvironment = {
    ...(globalEnvText === undefined ? {} : parse(globalEnvText)),
    ...(projectEnvText === undefined ? {} : parse(projectEnvText)),
  };
  if (globalEnvText !== undefined) sources.push(globalEnvPath);
  if (projectEnvText !== undefined) sources.push(envPath);

  // Populate process.env with .env values so they are visible to module-level
  // consumers (OAUTH_DEFAULTS, etc.). Never override an already-set env var.
  for (const [key, value] of Object.entries(projectEnvironment)) {
    if (value !== undefined && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }

  // Seed global .env on first use — copy any flavor-relevant env vars from
  // the current environment so they are available from any project directory.
  await seedGlobalEnv(globalEnvPath);

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

const SECRET_FIELD_SUFFIXES = ["apikey", "authorization", "token", "password", "secret"] as const;

function isSecretField(key: string): boolean {
  const normalized = key.replace(/[-_.]/g, "").toLowerCase();
  return SECRET_FIELD_SUFFIXES.some((suffix) => normalized.endsWith(suffix));
}

export async function setProjectMcpServerDisabled(
  cwd: string,
  serverName: string,
  disabled: boolean,
): Promise<string> {
  const directory = join(cwd, ".flavor");
  const path = join(directory, "flavor.json");
  const projectConfig = await readJsonIfPresent(path) ?? {};
  const currentServers = projectConfig["mcpServers"];
  if (currentServers !== undefined && !isPlainObject(currentServers)) {
    throw new Error(`Configuration field mcpServers in ${path} must be an object`);
  }
  const servers: ConfigObject = { ...(currentServers ?? {}) };
  const currentServer = servers[serverName];
  if (currentServer !== undefined && !isPlainObject(currentServer)) {
    throw new Error(`MCP server ${serverName} in ${path} must be an object`);
  }
  servers[serverName] = { ...(currentServer ?? {}), disabled };
  projectConfig["mcpServers"] = servers;
  await mkdir(directory, { recursive: true });
  await writeFile(path, `${JSON.stringify(projectConfig, null, 2)}\n`, "utf8");
  return path;
}

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
      isSecretField(key) ? "[redacted]" : redactConfig(value),
    ]),
  );
}
