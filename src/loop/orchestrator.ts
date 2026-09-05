import type { AgentEvent } from "../agent/types.js";
import { message } from "../utils/error.js";
import { memoryRotationActive } from "../utils/memory-restart.js";
import { buildLoopCyclePrompt } from "../skills/builtin-loop.js";
import { budgetDecision, extendBudget, rejectBudget, type BudgetDimension } from "./budget.js";
import type { HallucinationGuard } from "../hallucination/guard.js";
import type { LoopWorkspaceResolution } from "./isolation.js";
import { LoopStateSchema, type LoopEvent, type LoopState, type LoopStatus, type LoopVerificationEvidence } from "./types.js";
import type { VerificationPlan } from "./verifier.js";

export interface LoopPersistence {
  create(state: LoopState): Promise<void>;
  save(state: LoopState): Promise<void>;
  append(event: LoopEvent): Promise<void>;
  /** Present when the store can reload a loop for resume after heap rotation. */
  load?(loopId: string): Promise<LoopState>;
}

export type LoopConfirmation = "approved" | "rejected" | "unavailable";

export type LoopRuntimeEvent =
  | { type: "loop-resolved"; loopId: string; workspace: string; isolation: "current" | "worktree"; verifierCommands: string[]; cycleCheckpoint: number; tokenCheckpoint: number }
  | { type: "loop-cycle-start"; loopId: string; cycle: number }
  | { type: "worker-event"; event: AgentEvent }
  | { type: "loop-verification"; loopId: string; cycle: number; evidence: LoopVerificationEvidence }
  | { type: "loop-budget"; loopId: string; dimensions: BudgetDimension[]; cycleCheckpoint: number; tokenCheckpoint: number }
  | { type: "loop-terminal"; loopId: string; status: Exclude<LoopStatus, "running">; reason: string };

export interface LoopOrchestratorOptions {
  workspace: string;
  config: { maxCycles: number; maxTokens: number; isolation: "auto" };
  persistence: LoopPersistence;
  prepareWorkspace(input: { root: string; loopId: string; goal: string; signal: AbortSignal }): Promise<LoopWorkspaceResolution>;
  inferVerification(workspace: string): Promise<VerificationPlan>;
  runWorker(input: { goal: string; cycle: number; workspace: string; prompt: string; signal: AbortSignal }): AsyncIterable<AgentEvent>;
  runVerifier(plan: VerificationPlan, workspace: string, signal: AbortSignal): Promise<LoopVerificationEvidence>;
  confirmBudget(state: LoopState, dimensions: readonly BudgetDimension[], signal: AbortSignal): Promise<LoopConfirmation>;
  fingerprint(workspace: string): Promise<string>;
  /**
   * Called at every cycle boundary (state persisted). Production uses it to
   * rotate onto a fresh heap between cycles so multi-day loops never die on
   * a grown heap; the relaunched process resumes the loop from its state.
   */
  onCycleBoundary?(loopId: string): void | Promise<void>;
  /** Optional hallucination guard for confidence checks and retry monitoring. */
  hallucinationGuard?: HallucinationGuard;
  now?(): string;
  idFactory?(): string;
}

export class LoopOrchestrator {
  readonly #options: LoopOrchestratorOptions;

  constructor(options: LoopOrchestratorOptions) { this.#options = options; }

  async *run(request: { goal: string; signal: AbortSignal }): AsyncIterable<LoopRuntimeEvent> {
    const now = this.#options.now ?? (() => new Date().toISOString());
    const loopId = this.#options.idFactory?.() ?? `loop-${Date.now().toString(36)}`;
    const createdAt = now();
    let state = LoopStateSchema.parse({
      version: 1, loopId, goal: request.goal, workspace: this.#options.workspace,
      createdAt, updatedAt: createdAt, status: "running",
      config: {
        cycleStep: this.#options.config.maxCycles,
        tokenStep: this.#options.config.maxTokens,
        isolation: "auto",
      },
      budget: {
        cyclesUsed: 0, inputTokens: 0, outputTokens: 0,
        cycleCheckpoint: this.#options.config.maxCycles,
        tokenCheckpoint: this.#options.config.maxTokens,
        approvals: [],
      },
      cycles: [],
    });
    await this.#options.persistence.create(state);
    yield* this.#execute(state, request.goal, request.signal);
  }

  /**
   * Continue a loop whose process rotated onto a fresh heap. The persisted
   * state decides where to pick up; an interrupted cycle simply runs again.
   */
  async *resume(request: { loopId: string; signal: AbortSignal }): AsyncIterable<LoopRuntimeEvent> {
    // Call load() on its receiver: the real store reads #private fields, so a
    // detached `const load = persistence.load` would throw on every resume.
    const persistence = this.#options.persistence;
    if (persistence.load === undefined) throw new Error("Loop persistence does not support resume");
    let state: LoopState;
    try {
      state = await persistence.load(request.loopId);
    } catch (error) {
      yield { type: "loop-terminal", loopId: request.loopId, status: "failed", reason: message(error) };
      return;
    }
    if (state.status !== "running") {
      const status = state.status;
      yield { type: "loop-terminal", loopId: state.loopId, status, reason: state.terminalReason ?? "The loop is not running." };
      return;
    }
    yield* this.#execute(state, state.goal, request.signal);
  }

  async *#execute(initialState: LoopState, goal: string, signal: AbortSignal): AsyncIterable<LoopRuntimeEvent> {
    const now = this.#options.now ?? (() => new Date().toISOString());
    const loopId = initialState.loopId;
    let state = initialState;

    try {
      const workspaceResolution = await this.#options.prepareWorkspace({
        root: this.#options.workspace, loopId, goal, signal,
      });
      if (workspaceResolution.kind === "needs_human") {
        state = await this.#terminal(state, "needs_human", workspaceResolution.reason, now());
        yield { type: "loop-terminal", loopId, status: "needs_human", reason: workspaceResolution.reason };
        return;
      }
      const executionWorkspace = workspaceResolution.workspace;
      let plan = await this.#options.inferVerification(executionWorkspace.root);
      yield {
        type: "loop-resolved", loopId, workspace: executionWorkspace.root, isolation: executionWorkspace.mode,
        verifierCommands: plan.commands.map((item) => [item.command, ...item.args].join(" ")),
        cycleCheckpoint: state.budget.cycleCheckpoint, tokenCheckpoint: state.budget.tokenCheckpoint,
      };

      let previousVerification: LoopVerificationEvidence | undefined = plan.commands.length === 0
        ? {
            passed: false,
            commands: [],
            summary: `${plan.needsHumanReason ?? "No deterministic verification command was found."} `
              + "Inspect the project and establish a meaningful project-native deterministic check; never add a trivial pass-through verifier.",
          }
        : undefined;
      let previousFailureSignature: string | undefined;
      let repeatedFailures = 0;
      while (state.status === "running") {
        signal.throwIfAborted();
        // Cycle boundary: the previous cycle is fully persisted, so a heap
        // rotation requested here loses nothing but the grown heap.
        await this.#options.onCycleBoundary?.(loopId);
        // A boundary rotation was requested: stop cleanly and leave the state
        // running so the relaunched process resumes from the persisted cycle.
        if (memoryRotationActive()) return;
        const cycle = state.budget.cyclesUsed + 1;
        const startedAt = now();
        await this.#options.persistence.append({ version: 1, type: "cycle_started", timestamp: startedAt, loopId, payload: { cycle } });
        yield { type: "loop-cycle-start", loopId, cycle };
        const prompt = buildLoopCyclePrompt({
          goal, cycle,
          ...(previousVerification === undefined ? {} : {
            memory: `Previous host verification: ${previousVerification.summary}`,
            verification: previousVerification,
          }),
        });
        let cycleInputTokens = 0;
        let cycleOutputTokens = 0;
        let workerError: string | undefined;
        let workerMemoryPressure = false;
        let workerText = "";
        for await (const event of this.#options.runWorker({
          goal, cycle, workspace: executionWorkspace.root, prompt, signal,
        })) {
          if (event.type === "usage") {
            cycleInputTokens += event.inputTokens;
            cycleOutputTokens += event.outputTokens;
          }
          if (event.type === "error") {
            workerError = event.error.message;
            // The worker hit the hard heap guard: the cycle is interrupted but
            // the loop itself survives on the relaunched process, so leave
            // the state running instead of terminalizing it.
            if (event.error.code === "memory_pressure") workerMemoryPressure = true;
          }
          if (event.type === "text") workerText += event.text;
          // Hallucination guard: record tool calls and results
          if (this.#options.hallucinationGuard !== undefined) {
            if (event.type === "tool-start") {
              this.#options.hallucinationGuard.recordToolCall(event.name, event.input, event.id);
            } else if (event.type === "tool-end") {
              this.#options.hallucinationGuard.recordToolResult(event.name, event.result, event.id);
            }
          }
          yield { type: "worker-event", event };
        }
        if (workerMemoryPressure) return;
        if (workerError !== undefined) {
          state = LoopStateSchema.parse({
            ...state,
            budget: {
              ...state.budget,
              cyclesUsed: cycle,
              inputTokens: state.budget.inputTokens + cycleInputTokens,
              outputTokens: state.budget.outputTokens + cycleOutputTokens,
            },
          });
          state = await this.#terminal(state, "failed", workerError, now());
          yield { type: "loop-terminal", loopId, status: "failed", reason: workerError };
          return;
        }

        if (plan.commands.length === 0) {
          plan = await this.#options.inferVerification(executionWorkspace.root);
          if (plan.commands.length > 0) {
            yield {
              type: "loop-resolved", loopId, workspace: executionWorkspace.root, isolation: executionWorkspace.mode,
              verifierCommands: plan.commands.map((item) => [item.command, ...item.args].join(" ")),
              cycleCheckpoint: state.budget.cycleCheckpoint, tokenCheckpoint: state.budget.tokenCheckpoint,
            };
          }
        }
        const verifierUnavailable = plan.commands.length === 0;
        const evidence: LoopVerificationEvidence = verifierUnavailable
          ? {
              passed: false,
              commands: [],
              summary: plan.needsHumanReason ?? "No deterministic verification command was found after the discovery cycle.",
            }
          : await this.#options.runVerifier(plan, executionWorkspace.root, signal);
        const fingerprint = await this.#options.fingerprint(executionWorkspace.root);
        const completedAt = now();
        state = LoopStateSchema.parse({
          ...state,
          updatedAt: completedAt,
          budget: {
            ...state.budget,
            cyclesUsed: cycle,
            inputTokens: state.budget.inputTokens + cycleInputTokens,
            outputTokens: state.budget.outputTokens + cycleOutputTokens,
          },
          cycles: [...state.cycles, {
            cycle, startedAt, completedAt, inputTokens: cycleInputTokens, outputTokens: cycleOutputTokens,
            workspaceFingerprint: fingerprint, verification: evidence,
          }],
        });
        await this.#options.persistence.save(state);
        await this.#options.persistence.append({
          version: 1, type: "cycle_completed", timestamp: completedAt, loopId,
          payload: { cycle, passed: evidence.passed, inputTokens: cycleInputTokens, outputTokens: cycleOutputTokens },
        });
        yield { type: "loop-verification", loopId, cycle, evidence };

        if (verifierUnavailable) {
          const reason = `${evidence.summary} The discovery cycle completed, but host verification still requires human guidance.`;
          state = await this.#terminal(state, "needs_human", reason, now());
          yield { type: "loop-terminal", loopId, status: "needs_human", reason };
          return;
        }

        if (evidence.passed) {
          // Hallucination guard: check confidence before declaring success
          let guardWarnings: string[] = [];
          if (this.#options.hallucinationGuard !== undefined) {
            try {
              const report = await this.#options.hallucinationGuard.evaluate(goal, workerText);
              if (!report.passed) {
                const guardReason = report.blockingReasons.join("; ")
                  || "Hallucination guard blocked completion.";
                state = await this.#terminal(state, "failed", guardReason, now());
                yield { type: "loop-terminal", loopId, status: "failed", reason: guardReason };
                return;
              }
              guardWarnings = report.warnings;
            } catch {
              // Guard evaluation failure is not fatal — proceed with success
            }
          }
          const reason = [evidence.summary, ...guardWarnings].filter(Boolean).join("; ");
          state = await this.#terminal(state, "succeeded", reason, now());
          yield { type: "loop-terminal", loopId, status: "succeeded", reason };
          return;
        }
        const failureSignature = `${fingerprint}\n${evidence.summary}`;
        repeatedFailures = failureSignature === previousFailureSignature ? repeatedFailures + 1 : 1;
        previousFailureSignature = failureSignature;
        previousVerification = evidence;
        if (repeatedFailures >= 3) {
          const reason = "The same verification failure repeated three times without material workspace progress.";
          state = await this.#terminal(state, "no_progress", reason, now());
          yield { type: "loop-terminal", loopId, status: "no_progress", reason };
          return;
        }

        const decision = budgetDecision(state);
        if (decision.kind === "confirm") {
          yield {
            type: "loop-budget", loopId, dimensions: decision.dimensions,
            cycleCheckpoint: state.budget.cycleCheckpoint, tokenCheckpoint: state.budget.tokenCheckpoint,
          };
          const confirmation = await this.#options.confirmBudget(state, decision.dimensions, signal);
          if (confirmation === "unavailable") {
            const reason = "Loop budget extension requires user confirmation.";
            state = await this.#terminal(state, "needs_human", reason, now());
            yield { type: "loop-terminal", loopId, status: "needs_human", reason };
            return;
          }
          if (confirmation === "rejected") {
            const reason = "User declined to extend the loop budget.";
            state = rejectBudget(state, reason);
            await this.#options.persistence.save(state);
            await this.#options.persistence.append({ version: 1, type: "terminal", timestamp: now(), loopId, payload: { status: state.status, reason } });
            yield { type: "loop-terminal", loopId, status: "budget_exhausted", reason };
            return;
          }
          state = extendBudget(state, decision.dimensions, now());
          await this.#options.persistence.save(state);
          await this.#options.persistence.append({
            version: 1, type: "budget_approved", timestamp: state.updatedAt, loopId,
            payload: { dimensions: decision.dimensions, cycleCheckpoint: state.budget.cycleCheckpoint, tokenCheckpoint: state.budget.tokenCheckpoint },
          });
        }
      }
    } catch (error) {
      // A heap rotation aborts this generator while the session shuts down;
      // the loop state must stay "running" so the relaunched process resumes.
      if (memoryRotationActive()) return;
      const status = signal.aborted ? "cancelled" : "failed";
      const reason = signal.aborted ? "Loop cancelled by user." : message(error);
      state = await this.#terminal(state, status, reason, now());
      yield { type: "loop-terminal", loopId, status, reason };
    }
  }

  async #terminal(
    input: LoopState,
    status: Exclude<LoopStatus, "running">,
    terminalReason: string,
    timestamp: string,
  ): Promise<LoopState> {
    const state = LoopStateSchema.parse({ ...input, status, terminalReason, updatedAt: timestamp });
    await this.#options.persistence.save(state);
    await this.#options.persistence.append({
      version: 1, type: "terminal", timestamp, loopId: state.loopId, payload: { status, reason: terminalReason },
    });
    return state;
  }
}
