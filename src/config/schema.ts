import { z } from "zod";

export const PERMISSION_MODES = [
  "default", "acceptEdits", "plan", "bypassPermissions", "auto", "bubble",
] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];
export type LegacyPermissionMode = "safe" | "workspace" | "full";

export function normalizePermissionMode(value: unknown): unknown {
  if (value === "safe" || value === "workspace") return "default";
  if (value === "full") return "bypassPermissions";
  return value;
}

export const PermissionModeSchema = z.preprocess(
  normalizePermissionMode,
  z.enum(PERMISSION_MODES).default("default"),
);

export const ProviderConfigSchema = z.object({
  type: z.string(),
  baseURL: z.string().url().optional(),
  apiKey: z.string().optional(),
  defaultModel: z.string().min(1).optional(),
  cheapModel: z.string().min(1).optional(),
  models: z.array(z.string().min(1)).max(100).optional(),
  maxOutputTokens: z.number().int().positive().optional(),
  // OAuth PKCE fields
  apiType: z.enum(["openai", "anthropic"]).optional(),
  authorizationUrl: z.string().url().optional(),
  tokenUrl: z.string().url().optional(),
  clientId: z.string().min(1).optional(),
  scope: z.string().optional(),
});

const McpServerCommonShape = {
  disabled: z.boolean().default(false),
  timeoutMs: z.number().int().min(100).max(30 * 60_000).default(60_000),
};

export const McpStdioServerConfigSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).default({}),
  cwd: z.string().min(1).optional(),
  ...McpServerCommonShape,
}).strict();

export const McpHttpServerConfigSchema = z.object({
  url: z.string().url().refine((value) => {
    const protocol = new URL(value).protocol;
    return protocol === "http:" || protocol === "https:";
  }, "MCP HTTP URLs must use http or https"),
  headers: z.record(z.string(), z.string()).default({}),
  ...McpServerCommonShape,
}).strict();

export const McpServerConfigSchema = z.union([
  McpStdioServerConfigSchema,
  McpHttpServerConfigSchema,
]);

export const McpServerNameSchema = z.string()
  .min(1)
  .max(32)
  .regex(/^[A-Za-z0-9_-]+$/, "MCP server names may contain only letters, digits, underscores, and hyphens");

export const SkillNameSchema = z.string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Skill names must use lowercase letters, digits, and single hyphens");

export const FlavorConfigSchema = z.object({
  sleep: z.boolean().default(false),
  providers: z.record(z.string(), ProviderConfigSchema).default({}),
  mcpServers: z.record(McpServerNameSchema, McpServerConfigSchema).default({}),
  skills: z.object({
    disabled: z.array(SkillNameSchema).max(1_000).default([]),
  }).prefault({}),
  agents: z
    .object({
      main: z.object({ model: z.string() }).optional(),
      subagent: z.object({ model: z.string() }).optional(),
    })
    .optional(),
  maxSubagents: z.number().int().min(1).max(16).default(3),
  maxSessions: z.number().int().min(1).max(1000).default(50),
  memory: z
    .object({
      enabled: z.boolean().default(true),
      autoExtract: z.boolean().default(true),
      autoExtractMinChars: z.number().int().min(200).max(100_000).default(200),
      scoreThreshold: z.number().int().min(0).max(12).default(9),
      maxCandidatesPerTask: z.number().int().min(1).max(10).default(3),
      retrievalTopK: z.number().int().min(1).max(20).default(5),
      maxEntries: z.number().int().min(1).max(10_000).default(200),
      maxEntryChars: z.number().int().min(32).max(20_000).default(1_000),
      maxPromptChars: z.number().int().min(256).max(200_000).default(12_000),
    })
    .prefault({}),
  permissionMode: PermissionModeSchema,
  language: z
    .string()
    .regex(/^[a-z]{2}(-[A-Z]{2})?$/, "language must be a BCP47 tag like zh-CN or en-US")
    .optional(),
  hallucination: z
    .object({
      showWarnings: z.boolean().default(false),
      evaluationTimeoutMs: z.number().int().min(100).max(30_000).default(2_000),
    })
    .prefault({}),
  maxIterations: z
    .object({
      main: z.number().int().min(10).max(500).default(80),
      subagent: z.number().int().min(10).max(200).default(40),
      softLimitFactor: z.number().min(0.5).max(1.0).default(0.8),
      extendBy: z.number().int().min(5).max(100).default(20),
    })
    .prefault({}),
  loop: z
    .object({
      maxCycles: z.number().int().positive().max(10_000).default(20),
      maxTokens: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).default(500_000),
      isolation: z.literal("auto").default("auto"),
    })
    .prefault({}),
  context: z
    .object({
      windowTokens: z.number().int().positive().default(200_000),
      reservedOutputTokens: z.number().int().nonnegative().default(20_000),
      autoCompactBufferTokens: z.number().int().nonnegative().default(13_000),
      warningBufferTokens: z.number().int().nonnegative().default(20_000),
      blockingBufferTokens: z.number().int().nonnegative().default(3_000),
      microcompactKeepRecentToolResults: z.number().int().nonnegative().default(5),
      recentTokens: z.number().int().nonnegative().default(10_000),
      recentTextMessages: z.number().int().nonnegative().default(5),
      maxRecentTokens: z.number().int().nonnegative().default(40_000),
      /** @deprecated Character threshold retained for configuration compatibility. */
      compactAtChars: z.number().int().positive().optional(),
      toolOutputChars: z.number().int().positive().default(30_000),
    })
    .superRefine((context, issue) => {
      if (context.reservedOutputTokens >= context.windowTokens) issue.addIssue({
        code: "custom", path: ["reservedOutputTokens"], message: "reservedOutputTokens must be below windowTokens",
      });
      if (context.maxRecentTokens < context.recentTokens) issue.addIssue({
        code: "custom", path: ["maxRecentTokens"], message: "maxRecentTokens must be at least recentTokens",
      });
    })
    .prefault({}),
  incidents: z
    .object({
      enabled: z.boolean().default(false),
      webhookUrl: z.string().url().optional(),
    })
    .prefault({}),
});

export type FlavorConfig = z.infer<typeof FlavorConfigSchema>;
export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;
export type McpServerConfig = z.infer<typeof McpServerConfigSchema>;
export type McpServerConfigInput = z.input<typeof McpServerConfigSchema>;
export type McpStdioServerConfig = z.infer<typeof McpStdioServerConfigSchema>;
export type McpHttpServerConfig = z.infer<typeof McpHttpServerConfigSchema>;
