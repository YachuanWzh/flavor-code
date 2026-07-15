import type { ModelRegistry } from "../models/registry.js";
import { confidenceCheck } from "./confidence.js";
import { RetryMonitor } from "./retry-monitor.js";
import type { HallucinationReport } from "./types.js";
import { DEFAULT_CONFIDENCE_THRESHOLD } from "./types.js";

export interface HallucinationGuardConfig {
  registry: ModelRegistry;
  cheapModelId: string;
  confidenceThreshold?: number;
  maxToolRetries?: number;
  windowSize?: number;
  threshold?: number;
}

export class HallucinationGuard {
  readonly #registry: ModelRegistry;
  readonly #cheapModelId: string;
  readonly #confidenceThreshold: number;
  readonly #retryMonitor: RetryMonitor;
  readonly #lastParams = new Map<string, unknown>();

  constructor(config: HallucinationGuardConfig) {
    this.#registry = config.registry;
    this.#cheapModelId = config.cheapModelId;
    this.#confidenceThreshold = config.confidenceThreshold ?? DEFAULT_CONFIDENCE_THRESHOLD;
    const retryConfig: Record<string, number> = {};
    if (config.maxToolRetries !== undefined) retryConfig.maxToolRetries = config.maxToolRetries;
    if (config.windowSize !== undefined) retryConfig.windowSize = config.windowSize;
    if (config.threshold !== undefined) retryConfig.threshold = config.threshold;
    this.#retryMonitor = new RetryMonitor(retryConfig);
  }

  recordToolCall(toolName: string, params: unknown): void {
    this.#lastParams.set(toolName, params);
    this.#retryMonitor.recordCall(toolName, params);
  }

  recordToolResult(toolName: string, ok: boolean, errorCode?: string): void {
    if (ok) {
      this.#retryMonitor.recordSuccess(toolName);
    } else if (errorCode !== undefined) {
      const params = this.#lastParams.get(toolName);
      this.#retryMonitor.recordError(toolName, params ?? {}, errorCode);
    }
    this.#lastParams.delete(toolName);
  }

  async evaluate(query: string, output: string): Promise<HallucinationReport> {
    // 1. Retry monitor evaluation
    const retryResult = this.#retryMonitor.evaluate();

    // 2. Confidence check using cheap model
    let confidenceResult = null;
    try {
      confidenceResult = await confidenceCheck(
        this.#registry,
        this.#cheapModelId,
        query,
        output,
      );
    } catch {
      // Confidence check failed — treat as unavailable, not as hallucination
    }

    // 3. Determine pass/fail
    const confidenceFailed = confidenceResult !== null
      && confidenceResult.confidence < this.#confidenceThreshold;

    const passed = !confidenceFailed
      && retryResult.retryViolations.length === 0
      && !retryResult.circuitBreakerTripped;

    // 4. Reset state for next evaluation cycle
    this.#retryMonitor.reset();

    return {
      confidence: confidenceResult,
      retryViolations: retryResult.retryViolations,
      circuitBreakerTripped: retryResult.circuitBreakerTripped,
      circuitBreakerDetail: retryResult.circuitBreakerDetail,
      passed,
    };
  }

  reset(): void {
    this.#retryMonitor.reset();
  }
}
