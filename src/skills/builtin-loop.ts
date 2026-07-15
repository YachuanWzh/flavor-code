import type { LoopVerificationEvidence } from "../loop/types.js";

export const BUILTIN_LOOP_SKILL = {
  name: "loop",
  description: "Iteratively work toward a goal using host-owned verification evidence",
} as const;

export interface LoopCyclePromptInput {
  goal: string;
  cycle: number;
  memory?: string;
  verification?: LoopVerificationEvidence;
}

export function buildLoopCyclePrompt(input: LoopCyclePromptInput): string {
  return [
    "# Built-in Loop Skill",
    "Work toward the immutable goal in one bounded cycle. Inspect the workspace, make coherent progress, and run useful local checks.",
    "Do not delegate to subagents in this cycle because the outer orchestrator must account for every model token.",
    "A completion claim only requests host verification. You cannot approve success; only the host verifier can end the loop as succeeded.",
    "",
    `Goal: ${input.goal}`,
    `Cycle: ${input.cycle}`,
    `Loop memory: ${input.memory?.trim() || "No previous cycle evidence."}`,
    `Latest host verification: ${input.verification?.summary ?? "Not run yet."}`,
    "",
    "At the end, summarize material changes and remaining uncertainty. Do not invent verification results.",
  ].join("\n");
}
