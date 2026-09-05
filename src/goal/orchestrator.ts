import { createHash } from "node:crypto";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

import type { AgentEvent } from "../agent/types.js";
import type { ModelRegistry } from "../models/registry.js";
import { message } from "../utils/error.js";
import { memoryRotationActive } from "../utils/memory-restart.js";
import { runPlanner } from "./planner.js";
import { runClassifier, collectEvidence } from "./classifier.js";
import type {
  AggregatedOutcome,
  GoalRuntimeEvent,
  GoalState,
  Gap,
  HostVerificationEvidence,
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
  persistence?: {
    save(state: GoalState): Promise<void>;
    /** Present when the store can reload a goal for resume after heap rotation. */
    load?(goalId: string): Promise<GoalState>;
  };
  /**
   * Called at every round boundary (state persisted). Production uses it to
   * rotate onto a fresh heap between rounds so multi-day goals never die on
   * a grown heap; the relaunched process resumes the goal from its state.
   */
  onRoundBoundary?(goalId: string): void | Promise<void>;
  verifyHost?(signal: AbortSignal): Promise<HostVerificationEvidence>;
}

export class GoalOrchestrator {
  readonly #options: GoalOrchestratorOptions;

  constructor(options: GoalOrchestratorOptions) {
    if (options.skepticCount < 1 || options.skepticCount > 5) {
      throw new Error("skepticCount must be 1–5");
    }
    this.#options = options;
  }

  setModels(plannerModelId: string, classifierModelId: string): void {
    this.#options.plannerModelId = plannerModelId;
    this.#options.classifierModelId = classifierModelId;
  }

  async *run(request: { goal: string; signal: AbortSignal }): AsyncIterable<GoalRuntimeEvent> {
    const timestamp = (): string => this.#options.now?.() ?? new Date().toISOString();
    const createdAt = timestamp();
    const state: GoalState = {
      id: this.#options.idFactory?.() ?? `goal-${Date.now().toString(36)}`,
      objective: request.goal,
      phase: "planning",
      status: "active",
      plan: null,
      planPath: null,
      verifyRounds: 0,
      workerRounds: 0,
      lastGaps: [],
      gapFingerprint: "",
      stallStreak: 0,
      contractHash: contractHash(request.goal, null),
      evidenceRounds: [],
      createdAt,
      updatedAt: createdAt,
    };
    yield* this.#execute(state, request.signal);
  }

  /**
   * Continue a goal whose process rotated onto a fresh heap. The persisted
   * state decides where to pick up; an interrupted round simply runs again.
   */
  async *resume(request: { goalId: string; signal: AbortSignal }): AsyncIterable<GoalRuntimeEvent> {
    // Call load() on its receiver: the real store reads #private fields, so a
    // detached `const load = persistence.load` would throw on every resume.
    const persistence = this.#options.persistence;
    if (persistence === undefined || persistence.load === undefined) {
      throw new Error("Goal persistence does not support resume");
    }
    let state: GoalState;
    try {
      state = await persistence.load(request.goalId);
    } catch (error) {
      yield { type: "goal-failed", reason: message(error) };
      return;
    }
    if (state.status !== "active" && state.status !== "not_achieved") {
      yield { type: "goal-failed", reason: `Goal "${state.id}" is ${state.status}; it cannot be resumed.` };
      return;
    }
    yield { type: "goal-resumed", goalId: state.id, round: resumeStartRound(state) };
    yield* this.#execute(state, request.signal);
  }

  async *#execute(initialState: GoalState, signal: AbortSignal): AsyncIterable<GoalRuntimeEvent> {
    const timestamp = (): string => this.#options.now?.() ?? new Date().toISOString();
    let state = initialState;
    const persistState = async (patch?: Partial<GoalState>): Promise<void> => {
      state = { ...state, ...patch, updatedAt: timestamp() };
      await this.#options.persistence?.save(state);
    };
    await persistState();
    const workspace = this.#options.workspace;

    // ─── Phase 1: Planning (skipped when the resumed state already has a plan) ───
    let plan: Plan;
    let planPath: string;
    if (state.plan === null) {
      try {
        signal.throwIfAborted();
        plan = await runPlanner({
          registry: this.#options.registry,
          modelId: this.#options.plannerModelId,
          objective: state.objective,
          signal,
        });
        planPath = await writePlanFile(workspace, plan);
        await persistState({ phase: "executing", plan, planPath, contractHash: contractHash(state.objective, plan) });
        yield { type: "goal-plan-created", plan, planPath };
      } catch (error) {
        // A heap rotation aborts planning while the session shuts down; the
        // goal state must stay resumable so the relaunched process retries.
        if (memoryRotationActive()) return;
        const reason = `Goal planning failed: ${message(error)}`;
        await persistState({ phase: "complete", status: "failed" });
        yield { type: "goal-plan-failed", reason };
        yield { type: "goal-failed", reason };
        return;
      }
    } else {
      plan = state.plan;
      planPath = state.planPath ?? await writePlanFile(workspace, plan);
      await persistState({ phase: "executing", status: "active", ...(state.planPath === null ? { planPath } : {}) });
    }

    // ─── Phase 2: Execute-Verify Loop ───
    let priorGaps: Gap[] = state.lastGaps;
    let priorFingerprint = state.gapFingerprint;
    let stallStreak = state.stallStreak;
    const startRound = resumeStartRound(state);

    for (let round = startRound; round <= this.#options.maxRounds; round++) {
      signal.throwIfAborted();
      // Round boundary: the previous round is fully persisted, so a heap
      // rotation requested here loses nothing but the grown heap.
      await this.#options.onRoundBoundary?.(state.id);
      // A boundary rotation was requested: stop cleanly and leave the state
      // resumable so the relaunched process picks the goal back up.
      if (memoryRotationActive()) return;

      // Build the worker prompt with plan + prior gaps
      const workerPrompt = buildWorkerPrompt(state.objective, plan, priorGaps, round);
      await persistState({
        phase: "executing",
        status: "active",
        workerRounds: round,
        lastGaps: priorGaps,
        gapFingerprint: priorFingerprint,
        stallStreak,
      });
      yield { type: "goal-worker-start", round };

      let finalResponse = "";
      let workerError: string | undefined;
      let workerMemoryPressure = false;
      try {
        for await (const event of this.#options.runWorker({
          goal: state.objective,
          round,
          workspace,
          prompt: workerPrompt,
          priorGaps: formatPriorGaps(priorGaps),
          signal,
        })) {
          yield { type: "goal-worker-event", round, event };
          if (event.type === "text") finalResponse += event.text;
          if (event.type === "error") {
            workerError = event.error.message;
            // The worker hit the hard heap guard: the round is interrupted but
            // the goal itself survives on the relaunched process, so leave
            // the state resumable instead of terminalizing it.
            if (event.error.code === "memory_pressure") workerMemoryPressure = true;
            break;
          }
        }
      } catch (error) {
        if (memoryRotationActive()) return;
        workerError = message(error);
      }
      if (workerMemoryPressure) return;
      if (workerError !== undefined) {
        const reason = `Worker error in round ${round}: ${workerError}`;
        await persistState({ phase: "complete", status: "failed" });
        yield { type: "goal-failed", reason };
        return;
      }

      // ─── Phase 3: Verification ───
      await persistState({ phase: "verifying", status: "active", verifyRounds: round });
      yield { type: "goal-verification-start", round };
      const hostVerification = await this.#options.verifyHost?.(signal);
      const evidence = await collectEvidence(
        workspace,
        state.objective,
        finalResponse.slice(-4000), // Last 4000 chars of response
        formatPriorGaps(priorGaps),
        state.contractHash,
        hostVerification,
      );
      await persistState({ evidenceRounds: [...state.evidenceRounds, {
        round,
        workspaceDiffHash: evidence.workspaceDiffHash,
        ...(hostVerification === undefined ? {} : { hostVerification }),
      }] });

      let outcome: AggregatedOutcome;
      if (plan.kind === "code-change" && hostVerification !== undefined && !hostVerification.passed) {
        if (hostVerification.commands.length === 0) {
          outcome = { type: "blocked", reason: `Host verification unavailable: ${hostVerification.summary}` };
        } else {
          const gaps: Gap[] = [{ criterion: "host-verification", description: hostVerification.summary, blocking: "model_fixable" }];
          outcome = {
            type: "not_achieved", gaps, summary: hostVerification.summary,
            fingerprint: createHash("sha256").update(hostVerification.summary).digest("hex").slice(0, 16),
          };
        }
      } else try {
        outcome = await runClassifier(evidence, plan, {
          registry: this.#options.registry,
          modelId: this.#options.classifierModelId,
          skepticCount: this.#options.skepticCount,
          workspace,
          signal,
        });
      } catch (error) {
        outcome = {
          type: "blocked",
          reason: `Classifier infrastructure error: ${message(error)}`,
        };
      }

      yield {
        type: "goal-verdict",
        round,
        outcome,
        skepticCount: this.#options.skepticCount,
      };

      if (outcome.type === "achieved") {
        await persistState({ phase: "complete", status: "achieved", lastGaps: [] });
        yield { type: "goal-complete", summary: outcome.summary };
        return;
      }

      if (outcome.type === "blocked") {
        await persistState({ phase: "complete", status: "blocked" });
        yield { type: "goal-paused", reason: outcome.reason };
        yield { type: "goal-failed", reason: outcome.reason };
        return;
      }

      // Not achieved — check for stall
      if (outcome.fingerprint === priorFingerprint) {
        stallStreak++;
        if (stallStreak >= this.#options.maxStallStreak) {
          await persistState({
            phase: "complete",
            status: "failed",
            lastGaps: outcome.gaps,
            gapFingerprint: outcome.fingerprint,
            stallStreak,
          });
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
      await persistState({
        status: "not_achieved",
        lastGaps: priorGaps,
        gapFingerprint: priorFingerprint,
        stallStreak,
      });
    }

    // Max rounds reached
    await persistState({ phase: "complete", status: "failed" });
    yield {
      type: "goal-failed",
      reason: `Goal did not converge after ${this.#options.maxRounds} rounds. Last gaps: ${formatPriorGaps(priorGaps)}`,
    };
  }
}

function contractHash(objective: string, plan: Plan | null): string {
  return createHash("sha256").update(JSON.stringify({ objective, plan })).digest("hex");
}

/**
 * The round a resumed goal picks up at. workerRounds is stamped when a round
 * starts, so it is ambiguous on its own: verifyRounds disambiguates it.
 * - verifyRounds >= workerRounds: the last started round finished verification,
 *   so advance to the next round (never re-run a completed round, which would
 *   replay identical gaps and trip stall detection).
 * - verifyRounds <  workerRounds: the round was interrupted before it verified
 *   (a mid-round heap rotation), so run that same round again.
 * A fresh goal (both zero) starts at round 1.
 */
function resumeStartRound(state: GoalState): number {
  return state.verifyRounds >= state.workerRounds
    ? state.workerRounds + 1
    : Math.max(state.workerRounds, 1);
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
