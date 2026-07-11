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
  context: z
    .object({
      compactAtChars: z.number().int().positive().default(240_000),
      toolOutputChars: z.number().int().positive().default(30_000),
    })
    .prefault({}),
});

export type FlavorConfig = z.infer<typeof FlavorConfigSchema>;
export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;
