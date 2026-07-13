import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { ApiKeyAuthProvider } from "../../src/auth/types.js";
import { loadConfig, redactConfig } from "../../src/config/load.js";
import { FlavorConfigSchema } from "../../src/config/schema.js";

afterEach(() => {
  delete process.env.FLAVOR_TEST_KEY;
  delete process.env.CUSTOM_API_KEY;
});

it("uses Claude-style token compaction defaults and accepts explicit overrides", () => {
  expect(FlavorConfigSchema.parse({}).context).toMatchObject({
    windowTokens: 200_000,
    reservedOutputTokens: 20_000,
    autoCompactBufferTokens: 13_000,
    warningBufferTokens: 20_000,
    blockingBufferTokens: 3_000,
    microcompactKeepRecentToolResults: 5,
    recentTokens: 10_000,
    recentTextMessages: 5,
    maxRecentTokens: 40_000,
    toolOutputChars: 30_000,
  });

  expect(FlavorConfigSchema.parse({ context: {
    windowTokens: 128_000,
    reservedOutputTokens: 8_000,
    autoCompactBufferTokens: 10_000,
    warningBufferTokens: 12_000,
    blockingBufferTokens: 2_000,
    microcompactKeepRecentToolResults: 3,
    recentTokens: 8_000,
    recentTextMessages: 4,
    maxRecentTokens: 24_000,
    compactAtChars: 4_000,
  } }).context).toMatchObject({ windowTokens: 128_000, compactAtChars: 4_000 });
});

it("preserves a positive provider output token limit", () => {
  const parsed = FlavorConfigSchema.parse({
    providers: {
      deepseek: {
        type: "anthropic",
        maxOutputTokens: 65_536,
      },
    },
  });

  expect(parsed.providers.deepseek?.maxOutputTokens).toBe(65_536);
  expect(() => FlavorConfigSchema.parse({
    providers: { deepseek: { type: "anthropic", maxOutputTokens: 0 } },
  })).toThrow();
});

it("merges CLI, project, env, global, and defaults in precedence order", async () => {
  const root = await mkdtemp(join(tmpdir(), "flavor-config-"));
  const home = join(root, "home");
  const cwd = join(root, "repo");
  await mkdir(join(home, ".flavor-code"), { recursive: true });
  await mkdir(join(cwd, ".flavor"), { recursive: true });
  await writeFile(
    join(home, ".flavor-code", "flavor.json"),
    JSON.stringify({ maxSubagents: 2, permissionMode: "full" }),
  );
  await writeFile(
    join(cwd, ".flavor", "flavor.json"),
    JSON.stringify({ maxSubagents: 4, permissionMode: "safe" }),
  );
  await writeFile(join(cwd, ".env"), "OPENAI_API_KEY=project-secret\n");

  const loaded = await loadConfig({ cwd, home, cli: { maxSubagents: 5 } });

  expect(loaded.config.maxSubagents).toBe(5);
  expect(loaded.config.permissionMode).toBe("safe");
});

it("ignores undefined CLI overrides and preserves configured values", async () => {
  const root = await mkdtemp(join(tmpdir(), "flavor-config-"));
  const home = join(root, "home");
  const cwd = join(root, "repo");
  await mkdir(join(home, ".flavor-code"), { recursive: true });
  await mkdir(join(cwd, ".flavor"), { recursive: true });
  await writeFile(
    join(home, ".flavor-code", "flavor.json"),
    JSON.stringify({ maxSubagents: 2 }),
  );
  await writeFile(
    join(cwd, ".flavor", "flavor.json"),
    JSON.stringify({ maxSubagents: 4 }),
  );

  const loaded = await loadConfig({
    cwd,
    home,
    cli: { maxSubagents: undefined },
  });

  expect(loaded.config.maxSubagents).toBe(4);
});

it("interpolates and redacts provider secrets", () => {
  process.env.FLAVOR_TEST_KEY = "secret-value";
  const config = {
    providers: {
      custom: {
        type: "openai",
        apiKey: "${FLAVOR_TEST_KEY}",
        headers: { authorization: "Bearer secret-value" },
        credentials: [{ token: "secret-value" }],
      },
    },
  };

  const redacted = redactConfig(config);

  expect(JSON.stringify(redacted)).not.toContain("secret-value");
  expect(redacted).toEqual({
    providers: {
      custom: {
        type: "openai",
        apiKey: "[redacted]",
        headers: { authorization: "[redacted]" },
        credentials: [{ token: "[redacted]" }],
      },
    },
  });
  expect(config.providers.custom.apiKey).toBe("${FLAVOR_TEST_KEY}");
});

it("interpolates provider secrets from the project environment", async () => {
  const root = await mkdtemp(join(tmpdir(), "flavor-config-"));
  const home = join(root, "home");
  const cwd = join(root, "repo");
  await mkdir(join(cwd, ".flavor"), { recursive: true });
  process.env.CUSTOM_API_KEY = "process-secret";
  await writeFile(join(cwd, ".env"), "CUSTOM_API_KEY=project-secret\n");
  await writeFile(
    join(cwd, ".flavor", "flavor.json"),
    JSON.stringify({
      providers: {
        custom: { type: "openai", apiKey: "${CUSTOM_API_KEY}" },
      },
    }),
  );

  const loaded = await loadConfig({ cwd, home });

  expect(loaded.config.providers.custom?.apiKey).toBe("project-secret");
  expect(loaded.sources).toEqual([
    join(cwd, ".env"),
    join(cwd, ".flavor", "flavor.json"),
  ]);
});

it("uses an injected environment without consulting process.env and lets project .env override it", async () => {
  const root = await mkdtemp(join(tmpdir(), "flavor-config-"));
  const home = join(root, "home"); const cwd = join(root, "repo");
  await mkdir(join(cwd, ".flavor"), { recursive: true });
  process.env.CUSTOM_API_KEY = "unrelated-global";
  await writeFile(join(cwd, ".env"), "CUSTOM_API_KEY=project-value\n");
  await writeFile(join(cwd, ".flavor", "flavor.json"), JSON.stringify({
    providers: { custom: { type: "openai-compatible", apiKey: "${CUSTOM_API_KEY}", defaultModel: "large", cheapModel: "small" } },
  }));
  const loaded = await loadConfig({ cwd, home, environment: { CUSTOM_API_KEY: "injected-value" } });
  expect(loaded.config.providers.custom).toMatchObject({ apiKey: "project-value", defaultModel: "large", cheapModel: "small" });
});

it.each([
  {
    name: "global",
    relativePath: join(".flavor-code", "flavor.json"),
    underHome: true,
  },
  {
    name: "project",
    relativePath: join(".flavor", "flavor.json"),
    underHome: false,
  },
])("rejects a non-object $name configuration root with its source path", async ({
  relativePath,
  underHome,
}) => {
  const root = await mkdtemp(join(tmpdir(), "flavor-config-"));
  const home = join(root, "home");
  const cwd = join(root, "repo");
  const configPath = join(underHome ? home : cwd, relativePath);
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, JSON.stringify(["not", "an", "object"]));

  await expect(loadConfig({ cwd, home })).rejects.toThrow(
    `Configuration file ${configPath} must contain a JSON object`,
  );
});

it("resolves an API key as an authorization header", async () => {
  const auth = new ApiKeyAuthProvider("already-interpolated-key");

  await expect(auth.resolve("custom")).resolves.toEqual({
    headers: { authorization: "Bearer already-interpolated-key" },
  });
});
