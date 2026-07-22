import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { ApiKeyAuthProvider } from "../../src/auth/types.js";
import { loadConfig, redactConfig, setGlobalProviderConfig, setProjectMcpServerDisabled, setProjectProviderConfig } from "../../src/config/load.js";
import { FlavorConfigSchema } from "../../src/config/schema.js";

afterEach(() => {
  delete process.env.FLAVOR_TEST_KEY;
  delete process.env.CUSTOM_API_KEY;
});

it("keeps project sleep review opt-in", () => {
  expect(FlavorConfigSchema.parse({}).sleep).toBe(false);
  expect(FlavorConfigSchema.parse({ sleep: true }).sleep).toBe(true);
  expect(() => FlavorConfigSchema.parse({ sleep: "yes" })).toThrow();
});

it("uses bounded long-term-memory defaults and validates overrides", () => {
  expect(FlavorConfigSchema.parse({}).memory).toEqual({
    enabled: true,
    autoExtract: true,
    autoExtractMinChars: 200,
    scoreThreshold: 9,
    maxCandidatesPerTask: 3,
    retrievalTopK: 5,
    maxEntries: 200,
    maxEntryChars: 1000,
    maxPromptChars: 12000,
  });
  expect(() => FlavorConfigSchema.parse({ memory: { maxEntries: 0 } })).toThrow();
  expect(() => FlavorConfigSchema.parse({ memory: { maxEntryChars: 10 } })).toThrow();
  expect(() => FlavorConfigSchema.parse({ memory: { maxPromptChars: 100 } })).toThrow();
  expect(() => FlavorConfigSchema.parse({ memory: { autoExtractMinChars: 199 } })).toThrow();
  expect(() => FlavorConfigSchema.parse({ memory: { scoreThreshold: 13 } })).toThrow();
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

it("uses loop tranche defaults and validates explicit overrides", () => {
  expect(FlavorConfigSchema.parse({}).loop).toEqual({
    maxCycles: 20,
    maxTokens: 500_000,
    isolation: "auto",
  });
  expect(FlavorConfigSchema.parse({ loop: {
    maxCycles: 40,
    maxTokens: 5_000_000,
    isolation: "auto",
  } }).loop).toEqual({ maxCycles: 40, maxTokens: 5_000_000, isolation: "auto" });
  expect(() => FlavorConfigSchema.parse({ loop: { maxCycles: 0 } })).toThrow();
  expect(() => FlavorConfigSchema.parse({ loop: { maxTokens: 0 } })).toThrow();
  expect(() => FlavorConfigSchema.parse({ loop: { isolation: "current" } })).toThrow();
});

it("supports the six canonical permission modes and defaults to default", () => {
  expect(FlavorConfigSchema.parse({}).permissionMode).toBe("default");
  for (const permissionMode of [
    "default", "acceptEdits", "plan", "bypassPermissions", "auto", "bubble",
  ] as const) {
    expect(FlavorConfigSchema.parse({ permissionMode }).permissionMode).toBe(permissionMode);
  }
});

it.each([
  ["safe", "default"],
  ["workspace", "default"],
  ["full", "bypassPermissions"],
] as const)("migrates the legacy %s permission mode to %s", (legacy, canonical) => {
  expect(FlavorConfigSchema.parse({ permissionMode: legacy }).permissionMode).toBe(canonical);
});

it("uses the hallucination evaluation timeout default and validates overrides", () => {
  expect(FlavorConfigSchema.parse({}).hallucination).toEqual({
    showWarnings: false,
    evaluationTimeoutMs: 2_000,
  });
  expect(FlavorConfigSchema.parse({ hallucination: {
    showWarnings: true,
    evaluationTimeoutMs: 750,
  } }).hallucination).toEqual({ showWarnings: true, evaluationTimeoutMs: 750 });
  for (const value of [99, 30_001, 1.5]) {
    expect(() => FlavorConfigSchema.parse({
      hallucination: { evaluationTimeoutMs: value },
    })).toThrow();
  }
});

it("defaults MCP servers to an empty record", () => {
  expect(FlavorConfigSchema.parse({}).mcpServers).toEqual({});
});

it("persists an MCP enabled override in project configuration without losing existing fields", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "flavor-mcp-toggle-"));
  const path = join(cwd, ".flavor", "flavor.json");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify({
    language: "zh-CN",
    mcpServers: { filesystem: { command: "npx", args: ["server", "."] } },
  }));

  await setProjectMcpServerDisabled(cwd, "filesystem", true);

  expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
    language: "zh-CN",
    mcpServers: { filesystem: { command: "npx", args: ["server", "."], disabled: true } },
  });
});

it("serializes concurrent MCP updates and backs up the previous valid configuration", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "flavor-mcp-concurrent-"));
  const path = join(cwd, ".flavor", "flavor.json");
  await mkdir(dirname(path), { recursive: true });
  const original = {
    language: "zh-CN",
    mcpServers: {
      docs: { command: "node", args: ["docs.js"] },
      search: { command: "node", args: ["search.js"] },
    },
  };
  await writeFile(path, `${JSON.stringify(original, null, 2)}\n`);

  await Promise.all([
    setProjectMcpServerDisabled(cwd, "docs", true),
    setProjectMcpServerDisabled(cwd, "search", true),
  ]);

  expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
    language: "zh-CN",
    mcpServers: { docs: { disabled: true }, search: { disabled: true } },
  });
  expect(JSON.parse(await readFile(`${path}.bak`, "utf8"))).toMatchObject({
    language: "zh-CN",
    mcpServers: { docs: { command: "node" }, search: { command: "node" } },
  });
});

it("loads a valid backup when the primary project configuration is malformed", async () => {
  const root = await mkdtemp(join(tmpdir(), "flavor-config-backup-"));
  const home = join(root, "home");
  const cwd = join(root, "repo");
  const path = join(cwd, ".flavor", "flavor.json");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, "{ truncated");
  await writeFile(`${path}.bak`, JSON.stringify({ language: "zh-CN", maxSubagents: 7 }));

  const loaded = await loadConfig({ cwd, home });

  expect(loaded.config).toMatchObject({ language: "zh-CN", maxSubagents: 7 });
  expect(loaded.sources).toContain(`${path}.bak`);
});

it("migrates global plaintext secrets to authenticated envelopes without changing resolved values", async () => {
  const root = await mkdtemp(join(tmpdir(), "flavor-config-encryption-"));
  const home = join(root, "home");
  const cwd = join(root, "repo");
  const path = join(home, ".flavor-code", "flavor.json");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify({
    providers: { custom: { type: "openai", apiKey: "global-top-secret" } },
  }));

  const loaded = await loadConfig({ cwd, home });
  const persisted = await readFile(path, "utf8");
  const backup = await readFile(`${path}.bak`, "utf8");

  expect(loaded.config.providers.custom?.apiKey).toBe("global-top-secret");
  expect(persisted).not.toContain("global-top-secret");
  expect(backup).not.toContain("global-top-secret");
  expect(persisted).toContain("flavor:v1:");
  const key = await readFile(join(home, ".flavor-code", ".config.key"), "utf8");
  expect(Buffer.from(key.trim(), "base64")).toHaveLength(32);
});

it("adds global provider models without exposing their API keys on disk", async () => {
  const root = await mkdtemp(join(tmpdir(), "flavor-provider-save-"));
  const home = join(root, "home");
  const cwd = join(root, "repo");
  const path = join(home, ".flavor-code", "flavor.json");

  await setGlobalProviderConfig(home, "siliconflow", {
    type: "openai-compatible", baseURL: "https://api.siliconflow.cn/v1", apiKey: "secret-one",
    defaultModel: "qwen3-coder", models: ["qwen3-coder"],
  });
  await setGlobalProviderConfig(home, "siliconflow", {
    type: "openai-compatible", baseURL: "https://api.siliconflow.cn/v1", apiKey: "secret-two",
    defaultModel: "deepseek-v3", models: ["deepseek-v3"],
  });

  const persisted = await readFile(path, "utf8");
  const loaded = await loadConfig({ cwd, home });
  expect(persisted).not.toContain("secret-one");
  expect(persisted).not.toContain("secret-two");
  expect(persisted).toContain("flavor:v1:");
  expect(loaded.config.providers.siliconflow).toMatchObject({
    apiKey: "secret-two", defaultModel: "deepseek-v3", models: ["qwen3-coder", "deepseek-v3"],
  });
});

it("lets project provider fields override global fields while inheriting the encrypted global API key", async () => {
  const root = await mkdtemp(join(tmpdir(), "flavor-provider-precedence-"));
  const home = join(root, "home");
  const cwd = join(root, "repo");
  await setGlobalProviderConfig(home, "custom", {
    type: "openai-compatible", baseURL: "https://global.example.com/v1", apiKey: "global-secret",
    defaultModel: "global-model", models: ["global-model"],
  });
  await setProjectProviderConfig(cwd, "custom", {
    type: "anthropic", baseURL: "https://project.example.com", apiKey: "must-not-be-written",
    defaultModel: "project-model", models: ["project-model"],
  });

  const loaded = await loadConfig({ cwd, home });
  const projectRaw = await readFile(join(cwd, ".flavor", "flavor.json"), "utf8");
  expect(loaded.config.providers.custom).toMatchObject({
    type: "anthropic", baseURL: "https://project.example.com", apiKey: "global-secret",
    defaultModel: "project-model", models: ["project-model"],
  });
  expect(projectRaw).not.toContain("must-not-be-written");
  expect(projectRaw).not.toContain("apiKey");
});

it("recovers a tampered encrypted global configuration from its authenticated backup", async () => {
  const root = await mkdtemp(join(tmpdir(), "flavor-config-encrypted-backup-"));
  const home = join(root, "home");
  const cwd = join(root, "repo");
  const path = join(home, ".flavor-code", "flavor.json");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify({
    providers: { custom: { type: "openai", apiKey: "recover-me" } },
  }));
  await loadConfig({ cwd, home });

  const tamper = (raw: string) => raw.replace(/(flavor:v1:[^:\"]+:[^:\"]+:)([^\"])/, (_match, prefix: string, byte: string) =>
    `${prefix}${byte === "A" ? "B" : "A"}`,
  );
  await writeFile(path, tamper(await readFile(path, "utf8")));

  const loaded = await loadConfig({ cwd, home });
  expect(loaded.config.providers.custom?.apiKey).toBe("recover-me");
  expect(loaded.sources).toContain(`${path}.bak`);

  await writeFile(`${path}.bak`, tamper(await readFile(`${path}.bak`, "utf8")));
  await expect(loadConfig({ cwd, home })).rejects.toThrow(/authentic|decrypt|integrity|invalid/i);
});

it("accepts stdio and Streamable HTTP MCP server configurations", () => {
  const parsed = FlavorConfigSchema.parse({
    mcpServers: {
      filesystem: {
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-filesystem", "."],
        env: { MCP_TOKEN: "secret" },
        cwd: ".",
      },
      remote_api: {
        url: "https://mcp.example.com/mcp",
        headers: { Authorization: "Bearer secret" },
        timeoutMs: 120_000,
      },
    },
  });

  expect(parsed.mcpServers.filesystem).toEqual({
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem", "."],
    env: { MCP_TOKEN: "secret" },
    cwd: ".",
    disabled: false,
    timeoutMs: 60_000,
  });
  expect(parsed.mcpServers.remote_api).toEqual({
    url: "https://mcp.example.com/mcp",
    headers: { Authorization: "Bearer secret" },
    disabled: false,
    timeoutMs: 120_000,
  });
});

it("rejects ambiguous or unsafe MCP server configurations", () => {
  expect(() => FlavorConfigSchema.parse({
    mcpServers: { mixed: { command: "node", url: "https://mcp.example.com/mcp" } },
  })).toThrow();
  expect(() => FlavorConfigSchema.parse({
    mcpServers: { "unsafe server": { command: "node" } },
  })).toThrow();
  expect(() => FlavorConfigSchema.parse({
    mcpServers: { slow: { command: "node", timeoutMs: 0 } },
  })).toThrow();
  expect(() => FlavorConfigSchema.parse({
    mcpServers: { ftp: { url: "ftp://mcp.example.com/server" } },
  })).toThrow();
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
    JSON.stringify({ maxSubagents: 2, permissionMode: "full", loop: { maxCycles: 10, maxTokens: 1_000_000 } }),
  );
  await writeFile(
    join(cwd, ".flavor", "flavor.json"),
    JSON.stringify({ maxSubagents: 4, permissionMode: "safe", loop: { maxCycles: 30 } }),
  );
  await writeFile(join(cwd, ".env"), "OPENAI_API_KEY=project-secret\n");

  const loaded = await loadConfig({ cwd, home, cli: { maxSubagents: 5 } });

  expect(loaded.config.maxSubagents).toBe(5);
  expect(loaded.config.permissionMode).toBe("default");
  expect(loaded.config.loop).toEqual({ maxCycles: 30, maxTokens: 1_000_000, isolation: "auto" });
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

it("redacts case-insensitive MCP headers and secret environment variables", () => {
  const redacted = redactConfig({
    mcpServers: {
      remote: { headers: { Authorization: "Bearer secret", "X-Tenant": "demo" } },
      local: { env: { MCP_TOKEN: "secret", PATH: "safe-path" } },
    },
  });

  expect(redacted).toEqual({
    mcpServers: {
      remote: { headers: { Authorization: "[redacted]", "X-Tenant": "demo" } },
      local: { env: { MCP_TOKEN: "[redacted]", PATH: "safe-path" } },
    },
  });
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
