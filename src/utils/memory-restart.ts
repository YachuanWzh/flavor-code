import { join } from "node:path";

/**
 * Controlled-restart protocol for heap-pressure OOM protection.
 *
 * The agent loop stops a turn with `memory_pressure` before the V8 heap
 * reaches its hard limit; production then saves the session, writes a marker
 * and exits with MEMORY_RESTART_EXIT_CODE. The launcher reads the marker and
 * relaunches the CLI with `--resume <sessionId>`, so memory pressure restores
 * the saved session instead of ending in a fatal V8 OOM crash. The interrupted
 * turn is intentionally not replayed because it may contain non-idempotent tools.
 *
 * Boundary rotations (between turns, /loop cycles, /goal rounds) carry a
 * `continuation` in the marker: the relaunched process picks the interrupted
 * loop or goal back up from its persisted state, so multi-day autonomous runs
 * survive heap rotation without losing the long-running task.
 */
export const MEMORY_RESTART_EXIT_CODE = 75;
export const MEMORY_RESTART_MARKER_FILE = "memory-restart.json";
/**
 * Rotations are seamless (the session and any loop/goal resume automatically),
 * so the budget only exists to stop a pathological spin: 24 rotations inside
 * one hour still covers a multi-day run rotating every few hours.
 */
export const MEMORY_RESTART_MAX_ATTEMPTS = 24;
export const MEMORY_RESTART_WINDOW_MS = 60 * 60 * 1_000;
/** Two rotations closer together than this mean the fresh heap is born heavy; stop rotating and let the hard guard decide. */
export const MEMORY_RESTART_MIN_GAP_MS = 5 * 60 * 1_000;
/** A continuation is only honoured shortly after it was written. */
export const MEMORY_RESTART_CONTINUATION_TTL_MS = 10 * 60 * 1_000;
const SESSION_ID_PATTERN = /^session-[A-Za-z0-9_-]+$/u;

export interface MemoryRestartContinuation {
  kind: "loop" | "goal";
  id: string;
}

export interface MemoryRestartMarker {
  sessionId: string;
  requestedAt: string;
  attempts: number;
  continuation?: MemoryRestartContinuation;
}

let rotationActive = false;

/** Recorded when a rotation is requested; orchestrators skip terminal bookkeeping on the way out. */
export function markMemoryRotation(): void { rotationActive = true; }
export function memoryRotationActive(): boolean { return rotationActive; }

export function memoryRestartMarkerPath(workspace: string): string {
  return join(workspace, ".flavor", "tmp", MEMORY_RESTART_MARKER_FILE);
}

/**
 * Count restarts per session inside a rolling window. A marker for a
 * different session or an expired window starts counting from one again, so
 * a healthy long-lived session never exhausts the budget.
 */
export function nextMemoryRestartMarker(
  previous: MemoryRestartMarker | undefined,
  sessionId: string,
  now: Date,
  continuation?: MemoryRestartContinuation,
): MemoryRestartMarker {
  const reusable = previous !== undefined
    && previous.sessionId === sessionId
    && now.getTime() - Date.parse(previous.requestedAt) < MEMORY_RESTART_WINDOW_MS
    && Number.isInteger(previous.attempts) && previous.attempts > 0;
  return {
    sessionId,
    requestedAt: now.toISOString(),
    attempts: reusable ? previous!.attempts + 1 : 1,
    ...(continuation === undefined ? {} : { continuation }),
  };
}

/** True when the previous rotation for this session is too recent for another seamless one. */
export function rotationCooldownActive(marker: MemoryRestartMarker | undefined, sessionId: string, now: Date): boolean {
  return marker !== undefined
    && marker.sessionId === sessionId
    && now.getTime() - Date.parse(marker.requestedAt) < MEMORY_RESTART_MIN_GAP_MS;
}

/** The continuation a relaunched process should pick up, if still fresh. */
export function pendingContinuation(marker: MemoryRestartMarker | undefined, sessionId: string, now: Date): MemoryRestartContinuation | undefined {
  if (marker === undefined || marker.sessionId !== sessionId) return undefined;
  if (now.getTime() - Date.parse(marker.requestedAt) > MEMORY_RESTART_CONTINUATION_TTL_MS) return undefined;
  const continuation = marker.continuation;
  if (continuation === undefined) return undefined;
  if (continuation.kind !== "loop" && continuation.kind !== "goal") return undefined;
  if (typeof continuation.id !== "string" || continuation.id.length === 0) return undefined;
  return continuation;
}

export function shouldRelaunchForMemoryRestart(marker: MemoryRestartMarker | undefined): boolean {
  return marker !== undefined
    && SESSION_ID_PATTERN.test(marker.sessionId)
    && Number.isInteger(marker.attempts)
    && marker.attempts >= 1 && marker.attempts <= MEMORY_RESTART_MAX_ATTEMPTS;
}

/**
 * Rebuild the CLI arguments for the relaunched process: drop any existing
 * `--resume` selection and append the session the dying process asked for.
 * Returns undefined when the marker is missing or the budget is exhausted.
 */
export function memoryRestartArgs(argv: readonly string[], marker: MemoryRestartMarker | undefined): string[] | undefined {
  if (!shouldRelaunchForMemoryRestart(marker)) return undefined;
  const stripped: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === "--resume") {
      if (index + 1 < argv.length && !argv[index + 1]!.startsWith("-")) index += 1;
      continue;
    }
    if (argument.startsWith("--resume=")) continue;
    stripped.push(argument);
  }
  return [...stripped, "--resume", marker!.sessionId];
}

export function parseMemoryRestartMarker(json: string): MemoryRestartMarker | undefined {
  try {
    const value = JSON.parse(json) as Partial<MemoryRestartMarker>;
    if (typeof value.sessionId !== "string" || typeof value.requestedAt !== "string" || typeof value.attempts !== "number") {
      return undefined;
    }
    const continuation = value.continuation;
    if (continuation !== undefined
      && (typeof continuation !== "object" || continuation === null
        || (continuation.kind !== "loop" && continuation.kind !== "goal")
        || typeof continuation.id !== "string")) {
      return undefined;
    }
    return {
      sessionId: value.sessionId,
      requestedAt: value.requestedAt,
      attempts: value.attempts,
      ...(continuation === undefined ? {} : { continuation }),
    };
  } catch {
    return undefined;
  }
}
