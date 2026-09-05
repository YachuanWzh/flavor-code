/**
 * RSI configuration schema — task P0-01 (rsi.md section 20.5 / E1).
 *
 * Defaults are deliberately conservative: a parsed config is *not* an
 * authority grant. Auto-promotion additionally requires a control-layer
 * authorization handle (see `checkPromotionAuthority` in policy.ts), and
 * reserved kind/tier fields do not imply the pipeline supports them yet.
 */

import { z } from "zod";
import { RSI_AUTO_PROMOTABLE_RISKS, RSI_CANDIDATE_KINDS, RSI_MODES } from "./types.js";

export const RsiConfigSchema = z
  .object({
    mode: z.enum(RSI_MODES).default("observe"),
    scope: z.literal("project").default("project"),
    allowedKinds: z
      .array(z.enum(RSI_CANDIDATE_KINDS))
      .default(["prompt_rule", "skill"]),
    autoPromoteMaxRisk: z.enum(RSI_AUTO_PROMOTABLE_RISKS).nullable().default(null),
    runnerProfile: z.string().min(1).default("isolated-local"),
    dailyMaxTokens: z.number().int().positive().default(500_000),
    dailyComputeMinutes: z.number().int().positive().default(120),
    maxConcurrentJobs: z.number().int().positive().default(1),
    maxCandidatesPerCampaign: z.number().int().positive().default(3),
    maxDepthPerCampaign: z.number().int().positive().default(2),
    promotionContract: z.string().min(1).default("r1-quality-v1"),
    retainedStableReleases: z.number().int().min(2).default(3),
  })
  .strict();

export type RsiConfig = z.infer<typeof RsiConfigSchema>;
