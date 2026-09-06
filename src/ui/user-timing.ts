import { performance } from "node:perf_hooks";

/**
 * React 19's development reconciler emits User Timing entries for every
 * component commit. Node keeps them indefinitely unless the application
 * clears them. Release bundles use the production reconciler, while this
 * sweeper keeps source/dev builds and accidental packaging regressions bounded.
 */
export function clearUiUserTimingEntries(): void {
  performance.clearMarks();
  performance.clearMeasures();
}

export function installUiUserTimingSweeper(intervalMs = 250): () => void {
  if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0) {
    throw new Error("User Timing sweep interval must be a positive integer");
  }
  clearUiUserTimingEntries();
  const timer = setInterval(clearUiUserTimingEntries, intervalMs);
  timer.unref();
  return () => {
    clearInterval(timer);
    clearUiUserTimingEntries();
  };
}
