import { z } from "zod";

export const EvaluationSpecSchema = z.object({
  name: z.string().trim().min(1).max(256),
  workspace: z.string().trim().min(1).max(32_768),
  prompt: z.string().trim().min(1).max(1_000_000),
  verification: z.array(z.object({
    command: z.string().trim().min(1).max(32_768),
    args: z.array(z.string()).max(1_000),
    timeoutMs: z.number().int().positive().max(86_400_000).optional(),
  }).strict()).min(1).max(100),
  maxTokens: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
}).strict();
