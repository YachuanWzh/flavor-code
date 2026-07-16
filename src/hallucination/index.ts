export { HallucinationGuard } from "./guard.js";
export type { HallucinationGuardConfig } from "./guard.js";
export { SlidingWindow } from "./sliding-window.js";
export { RetryMonitor } from "./retry-monitor.js";
export type { RetryMonitorConfig } from "./retry-monitor.js";
export { confidenceCheck } from "./confidence.js";
export { EvidenceLedger } from "./evidence-ledger.js";
export type {
  CompactEvidenceEvent,
  EvidenceSnapshot,
} from "./evidence-ledger.js";
export type {
  ConfidenceResult,
  ConfidenceScores,
  HallucinationEvaluationStatus,
  HallucinationReport,
  RetryViolation,
} from "./types.js";
export {
  DEFAULT_EVALUATION_TIMEOUT_MS,
  DEFAULT_SLIDING_WINDOW_SIZE,
  DEFAULT_SLIDING_WINDOW_THRESHOLD,
  DEFAULT_MAX_TOOL_RETRIES,
  DEFAULT_CONFIDENCE_THRESHOLD,
} from "./types.js";
