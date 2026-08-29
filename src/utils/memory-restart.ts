import { join } from "node:path";

/**
 * Controlled-restart protocol for heap-pressure OOM protection.
 *
 * The agent loop stops a turn with `memory_pressure` before the V8 heap
 * reaches its hard limit; production then saves the session, writes a marker
 * and exits with MEMORY_RESTART_EXIT_CODE. The launcher reads the marker and
 * relaunches the CLI with `--resume <sessionId>`, so a retained-memory leak
 * degrades to a brief pause instead of a fatal V8 OOM crash.
 */
export const MEMORY_RESTART_EXIT_CODE = 75;
export const MEMORY_RESTART_MARKER_FILE = "memory-restart.json";
export const MEMORY_RESTART_MAX_ATTEMPTS = 3;
export const MEMORY_RESTART_WINDOW_MS = 30 * 60 * 1_000;
const SESSION_ID_PATTERN = /^session-[A-Za-z0-9_-]+$/u;

export interface MemoryRestartMarker {
  sessionId: string;
  requestedAt: string;
  attempts: number;
}

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
): MemoryRestartMarker {
  const reusable = previous !== undefined
    && previous.sessionId === sessionId
    && now.getTime() - Date.parse(previous.requestedAt) < MEMORY_RESTART_WINDOW_MS
    && Number.isInteger(previous.attempts) && previous.attempts > 0;
  return { sessionId, requestedAt: now.toISOString(), attempts: reusable ? previous!.attempts + 1 : 1 };
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
    return { sessionId: value.sessionId, requestedAt: value.requestedAt, attempts: value.attempts };
  } catch {
    return undefined;
  }
}
