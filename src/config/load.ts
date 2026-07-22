import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "dotenv";
import { FlavorConfigSchema, type FlavorConfig } from "./schema.js";
import { readRecoverableFile, updateProtectedFile } from "./protected-file.js";
import {
  decryptSecretFields,
  encryptSecretFields,
  hasPlainSecretFields,
  isSecretField,
  loadOrCreateConfigKey,
} from "./secret-envelope.js";

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

interface ReadConfigResult { value: ConfigObject; source: string }
interface GlobalConfigDocument { config: ConfigObject; hasPlainSecrets: boolean }

function parseConfigObject(path: string, raw: string): ConfigObject {
    const parsed: unknown = JSON.parse(raw);
    if (!isPlainObject(parsed)) {
      throw new Error(`Configuration file ${path} must contain a JSON object`);
    }
    return parsed;
}

async function readJsonIfPresent(path: string): Promise<ReadConfigResult | undefined> {
  const result = await readRecoverableFile(path, (raw) => parseConfigObject(path, raw));
  return result === undefined ? undefined : { value: result.value, source: result.source };
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

  const keyDirectory = join(options.home, ".flavor-code");
  let keyPromise: Promise<Buffer> | undefined;
  const getKey = () => keyPromise ??= loadOrCreateConfigKey(keyDirectory);
  const decodeGlobal = async (raw: string): Promise<GlobalConfigDocument> => {
    const stored = parseConfigObject(globalPath, raw);
    const hasPlainSecrets = hasPlainSecretFields(stored);
    const config = decryptSecretFields(stored, await getKey()) as ConfigObject;
    return { config, hasPlainSecrets };
  };
  const globalRead = await readRecoverableFile(globalPath, decodeGlobal);
  let globalConfig = globalRead?.value.config;
  if (globalRead?.value.hasPlainSecrets) {
      const key = await getKey();
      const protectedConfig = await updateProtectedFile<GlobalConfigDocument>({
        path: globalPath,
        decode: decodeGlobal,
        encode: (value) => `${JSON.stringify(encryptSecretFields(value.config, key), null, 2)}\n`,
        backupEncode: (value) => `${JSON.stringify(encryptSecretFields(value.config, key), null, 2)}\n`,
        update: (current) => current ?? { config: {}, hasPlainSecrets: false },
      });
      globalConfig = protectedConfig.config;
  }
  if (globalRead) sources.push(globalRead.source);

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

  const projectRead = await readJsonIfPresent(projectPath);
  const projectConfig = projectRead?.value;
  if (projectRead) sources.push(projectRead.source);

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

export async function setProjectMcpServerDisabled(
  cwd: string,
  serverName: string,
  disabled: boolean,
): Promise<string> {
  const directory = join(cwd, ".flavor");
  const path = join(directory, "flavor.json");
  await updateProtectedFile<ConfigObject>({
    path,
    decode: (raw) => parseConfigObject(path, raw),
    encode: (value) => `${JSON.stringify(value, null, 2)}\n`,
    update: (current) => {
      const projectConfig = { ...(current ?? {}) };
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
      return projectConfig;
    },
  });
  return path;
}

export async function setProjectSkillDisabled(
  cwd: string,
  skillName: string,
  disabled: boolean,
  inheritedDisabled: readonly string[] = [],
): Promise<string> {
  const directory = join(cwd, ".flavor");
  const path = join(directory, "flavor.json");
  await updateProtectedFile<ConfigObject>({
    path,
    decode: (raw) => parseConfigObject(path, raw),
    encode: (value) => `${JSON.stringify(value, null, 2)}\n`,
    update: (current) => {
      const projectConfig = { ...(current ?? {}) };
      const currentSkills = projectConfig["skills"];
      if (currentSkills !== undefined && !isPlainObject(currentSkills)) {
        throw new Error(`Configuration field skills in ${path} must be an object`);
      }
      const skills: ConfigObject = { ...(currentSkills ?? {}) };
      const currentDisabled = skills["disabled"];
      if (currentDisabled !== undefined && (!Array.isArray(currentDisabled)
        || currentDisabled.some((name) => typeof name !== "string"))) {
        throw new Error(`Configuration field skills.disabled in ${path} must be a string array`);
      }
      const names = new Set((currentDisabled ?? inheritedDisabled) as string[]);
      if (disabled) names.add(skillName);
      else names.delete(skillName);
      skills["disabled"] = [...names].sort();
      projectConfig["skills"] = skills;
      return projectConfig;
    },
  });
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
