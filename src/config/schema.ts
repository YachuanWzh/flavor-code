import { z } from "zod";

export const ProviderConfigSchema = z.object({
  type: z.string(),
  baseURL: z.string().url().optional(),
  apiKey: z.string().optional(),
  defaultModel: z.string().min(1).optional(),
  cheapModel: z.string().min(1).optional(),
});

export const FlavorConfigSchema = z.object({
  providers: z.record(z.string(), ProviderConfigSchema).default({}),
  agents: z
    .object({
      main: z.object({ model: z.string() }).optional(),
      subagent: z.object({ model: z.string() }).optional(),
    })
    .optional(),
  maxSubagents: z.number().int().min(1).max(16).default(3),
  permissionMode: z.enum(["safe", "workspace", "full"]).default("workspace"),
  language: z
    .string()
    .regex(/^[a-z]{2}(-[A-Z]{2})?$/, "language must be a BCP47 tag like zh-CN or en-US")
    .optional(),
  maxIterations: z
    .object({
      main: z.number().int().min(10).max(500).default(80),
      subagent: z.number().int().min(10).max(200).default(40),
      softLimitFactor: z.number().min(0.5).max(1.0).default(0.8),
      extendBy: z.number().int().min(5).max(100).default(20),
    })
    .prefault({}),
  context: z
    .object({
      compactAtChars: z.number().int().positive().default(240_000),
      toolOutputChars: z.number().int().positive().default(30_000),
    })
    .prefault({}),
});

export type FlavorConfig = z.infer<typeof FlavorConfigSchema>;
export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;
