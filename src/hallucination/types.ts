export interface ConfidenceScores {
  taskAlignment: number;
  evidenceGrounding: number;
  processReliability: number;
}

export type HallucinationEvaluationStatus = "completed" | "timeout" | "unavailable" | "skipped";

export interface ConfidenceResult {
  confidence: number;
  reason: string;
  scores?: ConfidenceScores;
  unsupportedClaims?: string[];
}

export interface SlidingWindowConfig {
  windowSize: number;
  threshold: number;
}

export const DEFAULT_SLIDING_WINDOW_SIZE = 20;
export const DEFAULT_SLIDING_WINDOW_THRESHOLD = 15;
export const DEFAULT_MAX_TOOL_RETRIES = 3;
export const DEFAULT_CONFIDENCE_THRESHOLD = 0.7;
export const DEFAULT_EVALUATION_TIMEOUT_MS = 2_000;

export interface ToolCallRecord {
  toolName: string;
  params: unknown;
  paramHash: string;
  iteration: number;
  errorCode?: string;
}

export interface RetryThresholds {
  maxToolRetries: number;
}

export interface HallucinationReport {
  confidence: ConfidenceResult | null;
  retryViolations: RetryViolation[];
  circuitBreakerTripped: boolean;
  circuitBreakerDetail: string | null;
  passed: boolean;
  /** Human-readable warning messages already localized to the configured language. */
  warnings: string[];
}

export interface RetryViolation {
  toolName: string;
  retryCount: number;
  maxRetries: number;
  lastErrorCode: string | null;
}
