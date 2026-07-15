import { z } from "zod";
import { withStructuredOutput } from "../models/structured.js";
import type { ModelRegistry } from "../models/registry.js";
import type { ConfidenceResult } from "./types.js";

const MAX_QUERY_CHARS = 5_000;
const MAX_OUTPUT_CHARS = 20_000;

// Note: we do NOT apply min/max in Zod so that the cheap model's
// raw output won't fail validation; clamping happens below.
const ConfidenceSchema = z.object({
  confidence: z.number(),
  reason: z.string(),
});

const PROMPT = `You are a task-completion verifier. Your job is to evaluate whether an agent's output
successfully addresses the user's query.

Compare the user's query with the agent's final output. Determine:
1. Whether the output actually addresses what was asked
2. Whether there are signs of hallucination (fabricated facts, URLs, command results)
3. Whether the work is genuinely complete

Return a JSON object with:
- "confidence": a number between 0.0 (completely wrong/hallucinated) and 1.0 (perfect match)
- "reason": a brief explanation of your assessment

Be strict: if the output references files or results the agent couldn't possibly know,
or makes claims without evidence, lower the confidence accordingly.`;

export async function confidenceCheck(
  registry: ModelRegistry,
  cheapModelId: string,
  query: string,
  output: string,
): Promise<ConfidenceResult> {
  const truncatedQuery = query.length > MAX_QUERY_CHARS
    ? `${query.slice(0, MAX_QUERY_CHARS)}...[truncated]`
    : query;
  const truncatedOutput = output.length > MAX_OUTPUT_CHARS
    ? `${output.slice(0, MAX_OUTPUT_CHARS)}...[truncated]`
    : output;

  const model = withStructuredOutput({
    registry,
    modelId: cheapModelId,
    name: "flavor_confidence",
    description: "Evaluate task completion confidence",
    schema: ConfidenceSchema,
  });

  const userMessage = [
    "User query:",
    truncatedQuery,
    "",
    "Agent output:",
    truncatedOutput,
    "",
    "Evaluate the confidence that the agent's output correctly and completely addresses the user's query.",
  ].join("\n");

  try {
    const result = await model.invoke({
      messages: [{ role: "system", content: PROMPT }, { role: "user", content: userMessage }],
    });
    // Clamp to ensure valid range
    const confidence = Math.max(0, Math.min(1, result.value.confidence));
    return { confidence, reason: result.value.reason };
  } catch (error) {
    throw new Error(
      `Confidence check failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
