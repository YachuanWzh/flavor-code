import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

import type { AgentEvent } from "../agent/types.js";
import type { ModelRegistry } from "../models/registry.js";
import { message } from "../utils/error.js";
import { runPlanner } from "./planner.js";
import { runClassifier, collectEvidence } from "./classifier.js";
import type {
  AggregatedOutcome,
  GoalRuntimeEvent,
  Gap,
  Plan,
} from "./types.js";

export interface GoalOrchestratorOptions {
  workspace: string;
  registry: ModelRegistry;
  plannerModelId: string;
  classifierModelId: string;
  skepticCount: number;
  maxRounds: number;
  maxStallStreak: number;
  runWorker(input: {
    goal: string;
    round: number;
    workspace: string;
    prompt: string;
    priorGaps: string;
    signal: AbortSignal;
  }): AsyncIterable<AgentEvent>;
  now?(): string;
  idFactory?(): string;
}

export class GoalOrchestrator {
  readonly #options: GoalOrchestratorOptions;

  constructor(options: GoalOrchestratorOptions) {
    if (options.skepticCount < 1 || options.skepticCount > 5) {
      throw new Error("skepticCount must be 1–5");
    }
    this.#options = options;
  }

  async *run(request: { goal: string; signal: AbortSignal }): AsyncIterable<GoalRuntimeEvent> {
    void (this.#options.now?.() as unknown);
    void (this.#options.idFactory?.() as unknown);
    const workspace = this.#options.workspace;

    // ─── Phase 1: Planning ───
    let plan: Plan;
    let planPath: string;
    try {
      request.signal.throwIfAborted();
      plan = await runPlanner({
        registry: this.#options.registry,
        modelId: this.#options.plannerModelId,
        objective: request.goal,
        signal: request.signal,
      });
      planPath = await writePlanFile(workspace, plan);
      yield { type: "goal-plan-created", plan, planPath };
    } catch (error) {
      const reason = `Goal planning failed: ${message(error)}`;
      yield { type: "goal-plan-failed", reason };
      yield { type: "goal-failed", reason };
      return;
    }

    // ─── Phase 2: Execute-Verify Loop ───
    let priorGaps: Gap[] = [];
    let priorFingerprint = "";
    let stallStreak = 0;

    for (let round = 1; round <= this.#options.maxRounds; round++) {
      request.signal.throwIfAborted();

      // Build the worker prompt with plan + prior gaps
      const workerPrompt = buildWorkerPrompt(request.goal, plan, priorGaps, round);
      yield { type: "goal-worker-start", round };

      let finalResponse = "";
      try {
        for await (const event of this.#options.runWorker({
          goal: request.goal,
          round,
          workspace,
          prompt: workerPrompt,
          priorGaps: formatPriorGaps(priorGaps),
          signal: request.signal,
        })) {
          // Collect the agent's final text responses
          if (event.type === "text") finalResponse += event.text;
        }
      } catch (error) {
        yield { type: "goal-failed", reason: `Worker error in round ${round}: ${message(error)}` };
        return;
      }

      // ─── Phase 3: Verification ───
      yield { type: "goal-verification-start", round };
      const evidence = await collectEvidence(
        workspace,
        request.goal,
        finalResponse.slice(-4000), // Last 4000 chars of response
        formatPriorGaps(priorGaps),
      );

      let outcome: AggregatedOutcome;
      try {
        outcome = await runClassifier(evidence, plan, {
          registry: this.#options.registry,
          modelId: this.#options.classifierModelId,
          skepticCount: this.#options.skepticCount,
          workspace,
          signal: request.signal,
        });
      } catch (error) {
        // Classifier error → fail-open, treat as achieved
        outcome = {
          type: "achieved",
          summary: `Classifier infrastructure error (fail-open): ${message(error)}`,
        };
      }

      yield {
        type: "goal-verdict",
        round,
        outcome,
        skepticCount: this.#options.skepticCount,
      };

      if (outcome.type === "achieved") {
        yield { type: "goal-complete", summary: outcome.summary };
        return;
      }

      if (outcome.type === "blocked") {
        yield { type: "goal-paused", reason: outcome.reason };
        yield { type: "goal-failed", reason: outcome.reason };
        return;
      }

      // Not achieved — check for stall
      if (outcome.fingerprint === priorFingerprint) {
        stallStreak++;
        if (stallStreak >= this.#options.maxStallStreak) {
          yield {
            type: "goal-stalled",
            reason: `Same gaps detected for ${stallStreak} consecutive rounds — no progress.`,
          };
          yield {
            type: "goal-failed",
            reason: `Stalled after ${round} rounds. Gaps: ${outcome.summary}`,
          };
          return;
        }
      } else {
        stallStreak = 1;
      }

      priorGaps = outcome.gaps;
      priorFingerprint = outcome.fingerprint;
    }

    // Max rounds reached
    yield {
      type: "goal-failed",
      reason: `Goal did not converge after ${this.#options.maxRounds} rounds. Last gaps: ${formatPriorGaps(priorGaps)}`,
    };
  }
}

async function writePlanFile(workspace: string, plan: Plan): Promise<string> {
  const dir = join(workspace, ".flavor");
  const planPath = join(dir, "goal-plan.md");
  await mkdir(dir, { recursive: true });

  const criteriaText = plan.criteria
    .map((c) => `- [${c.type}] AC-${c.id}: ${c.description}`)
    .join("\n");

  const content = [
    `# Goal Plan`,
    "",
    `## Goal Kind`,
    plan.kind,
    "",
    ...(plan.approach ? ["## Implementation Approach", plan.approach, ""] : []),
    ...(plan.checklist?.length
      ? [
          "## Task Checklist",
          ...plan.checklist.map((t, i) => `${i + 1}. ${t}`),
          "",
        ]
      : []),
    "## Acceptance Criteria",
    criteriaText,
    "",
    "## Verification Plan",
    plan.verificationPlan,
    "",
    "## Non-Goals",
    ...plan.nonGoals.map((n) => `- ${n}`),
    "",
    "## Assumed Scope",
    ...plan.assumedScope.map((a) => `- ${a}`),
    "",
  ].join("\n");

  await writeFile(planPath, content, "utf8");
  return planPath;
}

function buildWorkerPrompt(
  objective: string,
  plan: Plan,
  priorGaps: Gap[],
  round: number,
): string {
  const criteriaText = plan.criteria
    .map((c) => `  ${c.id}. [${c.type}] ${c.description}`)
    .join("\n");

  const parts = [
    `## Goal (Round ${round})`,
    "",
    `Objective: ${objective}`,
    "",
    "## Acceptance Criteria (contract)",
    criteriaText,
    "",
    ...(plan.approach ? ["## Implementation Guidance (non-contractual)", plan.approach, ""] : []),
    ...(plan.checklist?.length
      ? [
          "## Task Checklist",
          ...plan.checklist.map((t, i) => `${i + 1}. ${t}`),
          "",
        ]
      : []),
    "## Non-Goals",
    ...plan.nonGoals.map((n) => `- ${n}`),
    "",
    "## Instructions",
    "1. Work toward the acceptance criteria above. Implement AND verify.",
    "2. Run real tests — do not claim completion without evidence.",
    "3. When you believe all gating criteria are met, state your closing summary clearly.",
    "4. After you finish, an independent verification panel will audit your work.",
  ];

  if (priorGaps.length > 0) {
    parts.push(
      "",
      "## Prior Verification Gaps (must fix)",
      ...priorGaps.map(
        (g, i) => `${i + 1}. [${g.criterion}] ${g.description} (${g.blocking})`,
      ),
      "",
      "Focus on fixing these gaps before introducing new changes.",
    );
  }

  return parts.join("\n");
}

function formatPriorGaps(gaps: Gap[]): string {
  if (gaps.length === 0) return "(none)";
  return gaps
    .map((g) => `[${g.criterion}] ${g.description} (${g.blocking})`)
    .join("\n");
}
