import { z } from "zod";
import { withStructuredOutput } from "../models/structured.js";
import type { ModelRegistry } from "../models/registry.js";
import { awaitWithSignal } from "../utils/async.js";
import type { EvidenceSnapshot } from "./evidence-ledger.js";
import type { ConfidenceResult, ConfidenceScores } from "./types.js";
import { DEFAULT_EVALUATION_TIMEOUT_MS } from "./types.js";

const MAX_QUERY_CHARS = 5_000;
const MAX_OUTPUT_CHARS = 10_000;
const MAX_EVIDENCE_CHARS = 6_000;

const ConfidenceSchema = z.object({
  taskAlignment: z.number(),
  evidenceGrounding: z.number(),
  processReliability: z.number(),
  reason: z.string(),
  unsupportedClaims: z.array(z.string()).max(3),
});

const PROMPT = `You are a fast, evidence-aware task-completion verifier.

Evaluate three independent dimensions:
1. taskAlignment: whether the final output addresses all important user requirements.
2. evidenceGrounding: whether important final claims are supported by the supplied execution evidence.
3. processReliability: whether unresolved errors, contradictions, or false success claims remain.

Calibration rules:
- Do not penalize the choice of tool.
- A successful fallback after a failed tool is normal recovery when the evidence supports it.
- Do not penalize resolved intermediate failures.
- Penalize only unresolved failures relevant to the final conclusion.
- Explanation, reasoning, and creative tasks do not require tool evidence when tools are unnecessary.
- Omitted evidence is unknown, not proof that an action did not occur.
- Never invent evidence beyond the supplied query, output, and compact execution evidence.

Return one structured result containing scores from 0.0 to 1.0, one concise reason,
and at most three specific unsupported claims.`;

export interface ConfidenceCheckOptions {
  evidence?: EvidenceSnapshot;
  timeoutMs?: number;
}

export class HallucinationEvaluationTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`Hallucination evaluation timed out after ${timeoutMs}ms`);
    this.name = "HallucinationEvaluationTimeoutError";
  }
}

export async function confidenceCheck(
  registry: ModelRegistry,
  cheapModelId: string,
  query: string,
  output: string,
  options: ConfidenceCheckOptions = {},
): Promise<ConfidenceResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_EVALUATION_TIMEOUT_MS;
  const model = withStructuredOutput({
    registry,
    modelId: cheapModelId,
    name: "flavor_confidence",
    description: "Evaluate evidence-aware task completion confidence",
    schema: ConfidenceSchema,
    retry: { maxRetries: 0, backoffMs: [] },
  });
  const controller = new AbortController();
  const timeoutError = new HallucinationEvaluationTimeoutError(timeoutMs);
  const timer = setTimeout(() => controller.abort(timeoutError), timeoutMs);

  const userMessage = [
    "User query:",
    truncateHead(query, MAX_QUERY_CHARS),
    "",
    "Agent final output:",
    truncateHeadAndTail(output, MAX_OUTPUT_CHARS),
    "",
    "Execution evidence:",
    truncateHead(options.evidence?.text ?? emptyEvidence(), MAX_EVIDENCE_CHARS),
    "",
    "Evaluate the result using only the supplied material.",
  ].join("\n");

  try {
    const invocation = model.invoke({
      messages: [{ role: "system", content: PROMPT }, { role: "user", content: userMessage }],
      signal: controller.signal,
    });
    const result = await awaitWithSignal(invocation, controller.signal);
    const scores: ConfidenceScores = {
      taskAlignment: clamp(result.value.taskAlignment),
      evidenceGrounding: clamp(result.value.evidenceGrounding),
      processReliability: clamp(result.value.processReliability),
    };
    const confidence = 0.4 * scores.taskAlignment
      + 0.4 * scores.evidenceGrounding
      + 0.2 * scores.processReliability;
    return {
      confidence,
      reason: result.value.reason,
      scores,
      unsupportedClaims: result.value.unsupportedClaims,
    };
  } catch (error) {
    if (error instanceof HallucinationEvaluationTimeoutError) throw error;
    throw new Error(
      `Confidence check failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    clearTimeout(timer);
  }
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function truncateHead(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars - 14)}...[truncated]`;
}

function truncateHeadAndTail(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  const marker = "...[truncated]...";
  const remaining = maxChars - marker.length;
  const headChars = Math.ceil(remaining / 2);
  const tailChars = Math.floor(remaining / 2);
  return `${value.slice(0, headChars)}${marker}${value.slice(-tailChars)}`;
}

function emptyEvidence(): string {
  return JSON.stringify({ omittedCount: 0, foldedCount: 0, events: [] });
}
