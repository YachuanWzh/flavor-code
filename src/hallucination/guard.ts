import type { ModelRegistry } from "../models/registry.js";
import type { ToolResult } from "../tools/types.js";
import {
  confidenceCheck,
  HallucinationEvaluationTimeoutError,
} from "./confidence.js";
import { EvidenceLedger } from "./evidence-ledger.js";
import { buildWarningMessages } from "./messages.js";
import { RetryMonitor } from "./retry-monitor.js";
import type {
  ConfidenceResult,
  HallucinationEvaluationStatus,
  HallucinationReport,
} from "./types.js";
import {
  DEFAULT_CONFIDENCE_THRESHOLD,
  DEFAULT_EVALUATION_TIMEOUT_MS,
} from "./types.js";

export interface HallucinationGuardConfig {
  registry: ModelRegistry;
  cheapModelId: string;
  confidenceThreshold?: number;
  maxToolRetries?: number;
  windowSize?: number;
  threshold?: number;
  /** BCP47 language tag (e.g. "zh-CN", "en-US") for localized warning messages. */
  language?: string;
  /** When false, warning messages and the LLM scorer are suppressed. Default true. */
  showWarnings?: boolean;
  /** Hard deadline for one cheap-model evaluation. */
  evaluationTimeoutMs?: number;
}

export class HallucinationGuard {
  readonly #registry: ModelRegistry;
  readonly #cheapModelId: string;
  readonly #confidenceThreshold: number;
  readonly #evaluationTimeoutMs: number;
  readonly #retryMonitor: RetryMonitor;
  readonly #evidence = new EvidenceLedger();
  readonly #language: string;
  readonly #showWarnings: boolean;
  readonly #paramsByCallId = new Map<string, unknown>();
  readonly #legacyCallIds = new Map<string, string[]>();
  #legacySequence = 0;

  constructor(config: HallucinationGuardConfig) {
    this.#registry = config.registry;
    this.#cheapModelId = config.cheapModelId;
    this.#confidenceThreshold = config.confidenceThreshold ?? DEFAULT_CONFIDENCE_THRESHOLD;
    this.#evaluationTimeoutMs = config.evaluationTimeoutMs ?? DEFAULT_EVALUATION_TIMEOUT_MS;
    this.#language = config.language ?? "zh-CN";
    this.#showWarnings = config.showWarnings !== false;
    const retryConfig: Record<string, number> = {};
    if (config.maxToolRetries !== undefined) retryConfig.maxToolRetries = config.maxToolRetries;
    if (config.windowSize !== undefined) retryConfig.windowSize = config.windowSize;
    if (config.threshold !== undefined) retryConfig.threshold = config.threshold;
    this.#retryMonitor = new RetryMonitor(retryConfig);
  }

  recordToolCall(toolName: string, params: unknown, callId?: string): void {
    const resolvedCallId = callId ?? this.#createLegacyCallId(toolName);
    this.#paramsByCallId.set(resolvedCallId, params);
    this.#retryMonitor.recordCall(toolName, params);
    this.#evidence.recordCall(resolvedCallId, toolName, params);
  }

  recordToolResult(toolName: string, ok: boolean, errorCode?: string): void;
  recordToolResult(toolName: string, result: ToolResult, callId?: string): void;
  recordToolResult(
    toolName: string,
    resultOrOk: boolean | ToolResult,
    errorCodeOrCallId?: string,
  ): void {
    const result: ToolResult = typeof resultOrOk === "boolean"
      ? {
          ok: resultOrOk,
          ...(!resultOrOk && errorCodeOrCallId !== undefined
            ? { error: { code: errorCodeOrCallId, message: errorCodeOrCallId } }
            : {}),
        }
      : resultOrOk;
    const explicitCallId = typeof resultOrOk === "boolean" ? undefined : errorCodeOrCallId;
    const callId = explicitCallId ?? this.#takeLegacyCallId(toolName)
      ?? `unmatched-${this.#legacySequence++}`;
    const params = this.#paramsByCallId.get(callId) ?? {};

    if (result.ok) {
      this.#retryMonitor.recordSuccess(toolName);
    } else if (result.error?.code !== undefined) {
      this.#retryMonitor.recordError(toolName, params, result.error.code);
    }
    this.#evidence.recordResult(callId, toolName, result);
    this.#paramsByCallId.delete(callId);
  }

  async evaluate(query: string, output: string): Promise<HallucinationReport> {
    const retryResult = this.#retryMonitor.evaluate();
    const evidence = this.#evidence.snapshot();

    try {
      let confidence: ConfidenceResult | null = null;
      let evaluationStatus: HallucinationEvaluationStatus = "skipped";
      if (this.#showWarnings) {
        try {
          confidence = await confidenceCheck(
            this.#registry,
            this.#cheapModelId,
            query,
            output,
            { evidence, timeoutMs: this.#evaluationTimeoutMs },
          );
          evaluationStatus = "completed";
        } catch (error) {
          evaluationStatus = error instanceof HallucinationEvaluationTimeoutError
            ? "timeout"
            : "unavailable";
        }
      }

      const passed = retryResult.retryViolations.length === 0
        && !retryResult.circuitBreakerTripped;
      const deterministicReport = {
        confidence: null,
        retryViolations: retryResult.retryViolations,
        circuitBreakerTripped: retryResult.circuitBreakerTripped,
        circuitBreakerDetail: retryResult.circuitBreakerDetail,
        passed,
      };
      const blockingReasons = buildWarningMessages(deterministicReport, this.#language);
      const lowConfidence = confidence !== null
        && confidence.confidence < this.#confidenceThreshold;
      const warnings = this.#showWarnings
        ? buildWarningMessages({
            ...deterministicReport,
            confidence: lowConfidence ? confidence : null,
          }, this.#language)
        : [];

      return {
        confidence,
        evaluationStatus,
        retryViolations: retryResult.retryViolations,
        circuitBreakerTripped: retryResult.circuitBreakerTripped,
        circuitBreakerDetail: retryResult.circuitBreakerDetail,
        passed,
        blockingReasons,
        warnings,
      };
    } finally {
      this.reset();
    }
  }

  reset(): void {
    this.#retryMonitor.reset();
    this.#evidence.reset();
    this.#paramsByCallId.clear();
    this.#legacyCallIds.clear();
    this.#legacySequence = 0;
  }

  #createLegacyCallId(toolName: string): string {
    const callId = `legacy-${this.#legacySequence++}`;
    const queue = this.#legacyCallIds.get(toolName) ?? [];
    queue.push(callId);
    this.#legacyCallIds.set(toolName, queue);
    return callId;
  }

  #takeLegacyCallId(toolName: string): string | undefined {
    const queue = this.#legacyCallIds.get(toolName);
    const callId = queue?.shift();
    if (queue?.length === 0) this.#legacyCallIds.delete(toolName);
    return callId;
  }
}
