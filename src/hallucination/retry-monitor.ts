import { SlidingWindow } from "./sliding-window.js";
import type { RetryViolation } from "./types.js";
import { DEFAULT_MAX_TOOL_RETRIES } from "./types.js";

interface ToolErrorState {
  retryCount: number;
  lastErrorCode: string | null;
}

export interface RetryMonitorConfig {
  maxToolRetries: number;
  windowSize?: number;
  threshold?: number;
}

export class RetryMonitor {
  readonly #maxToolRetries: number;
  readonly #slidingWindow: SlidingWindow;
  readonly #errorStates = new Map<string, ToolErrorState>();

  constructor(config: Partial<RetryMonitorConfig> = {}) {
    this.#maxToolRetries = config.maxToolRetries ?? DEFAULT_MAX_TOOL_RETRIES;
    const windowConfig: Record<string, number> = {};
    if (config.windowSize !== undefined) windowConfig.windowSize = config.windowSize;
    if (config.threshold !== undefined) windowConfig.threshold = config.threshold;
    this.#slidingWindow = new SlidingWindow(windowConfig);
  }

  recordCall(toolName: string, params: unknown): void {
    this.#slidingWindow.push(toolName, params);
  }

  recordError(toolName: string, params: unknown, errorCode: string): void {
    this.#slidingWindow.push(toolName, params);
    const existing = this.#errorStates.get(toolName);
    if (existing === undefined) {
      this.#errorStates.set(toolName, { retryCount: 1, lastErrorCode: errorCode });
    } else {
      existing.retryCount += 1;
      existing.lastErrorCode = errorCode;
    }
  }

  recordSuccess(toolName: string): void {
    this.#errorStates.delete(toolName);
  }

  evaluate(): {
    retryViolations: RetryViolation[];
    circuitBreakerTripped: boolean;
    circuitBreakerDetail: string | null;
  } {
    const retryViolations: RetryViolation[] = [];
    for (const [toolName, state] of this.#errorStates) {
      if (state.retryCount >= this.#maxToolRetries) {
        retryViolations.push({
          toolName,
          retryCount: state.retryCount,
          maxRetries: this.#maxToolRetries,
          lastErrorCode: state.lastErrorCode,
        });
      }
    }

    let circuitBreakerDetail: string | null = null;
    if (this.#slidingWindow.isTripped()) {
      const toolName = this.#slidingWindow.trippedToolName ?? "unknown";
      const hash = this.#slidingWindow.trippedHash ?? "unknown";
      circuitBreakerDetail = `Circuit breaker tripped for tool "${toolName}": parameter hash ${hash.slice(0, 16)}... appeared too frequently in the sliding window.`;
    }

    return {
      retryViolations,
      circuitBreakerTripped: this.#slidingWindow.isTripped(),
      circuitBreakerDetail,
    };
  }

  reset(): void {
    this.#errorStates.clear();
    this.#slidingWindow.reset();
  }
}
