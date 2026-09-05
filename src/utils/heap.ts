import { getHeapStatistics } from "node:v8";

/**
 * Heap watermarks for the controlled rotation protocol.
 *
 * Long-running sessions (interactive turns, /loop cycles, /goal rounds) rotate
 * onto a fresh heap instead of growing until V8 dies. Two watermarks:
 *
 * - MEMORY_PRESSURE_HEAP_RATIO: hard guard checked before every model call.
 *   Tripping it stops the current turn; the session is persisted first.
 * - MEMORY_ROTATION_HEAP_RATIO: soft guard checked only at turn/cycle/round
 *   boundaries. Tripping it rotates between units of work, so multi-day runs
 *   keep going on a fresh heap without losing the loop or goal in flight.
 *
 * Both readings are GC-verified when --expose-gc is available (the launcher
 * injects it): heapUsed includes uncollected garbage, and declaring pressure
 * on garbage alone would rotate or stop turns for no reason. A full GC before
 * judging keeps the decision about the live set only.
 */
export const MEMORY_PRESSURE_HEAP_RATIO = 0.8;
export const MEMORY_ROTATION_HEAP_RATIO = 0.6;

/** Below this raw ratio no GC verification is worth the pause. */
const ROTATION_PRECHECK_RATIO = 0.45;

/** At or above this verified ratio a rotation also dumps a heap snapshot. */
const SNAPSHOT_HEAP_RATIO = 0.85;

export interface HeapReading {
  heapUsed: number;
  heapLimit: number;
  ratio: number;
  /** Ratio measured after a forced full GC; undefined when gc is not exposed. */
  verifiedRatio?: number;
  gcVerified: boolean;
}

export function readHeap(): { heapUsed: number; heapLimit: number; ratio: number } {
  const heapLimit = getHeapStatistics().heap_size_limit;
  const heapUsed = process.memoryUsage().heapUsed;
  return { heapUsed, heapLimit, ratio: heapLimit > 0 ? heapUsed / heapLimit : 0 };
}

function forceFullGc(): boolean {
  const gc = (globalThis as { gc?: () => void }).gc;
  if (typeof gc !== "function") return false;
  gc();
  gc();
  return true;
}

function ratioOf(heapLimit: number, heapUsed: number): number {
  return heapLimit > 0 ? heapUsed / heapLimit : 0;
}

/**
 * Hard-guard reading. Returns undefined below the threshold; when the raw
 * reading crosses it, a full GC (if exposed) decides whether the live set
 * really is that large. Without --expose-gc the raw reading stands.
 */
export function verifiedHeapPressure(threshold: number): HeapReading | undefined {
  const raw = readHeap();
  if (raw.heapLimit <= 0 || raw.ratio < threshold) return undefined;
  if (!forceFullGc()) return { ...raw, gcVerified: false };
  const heapUsed = process.memoryUsage().heapUsed;
  const ratio = ratioOf(raw.heapLimit, heapUsed);
  if (ratio < threshold) return undefined;
  return { heapUsed, heapLimit: raw.heapLimit, ratio, verifiedRatio: ratio, gcVerified: true };
}

/**
 * Boundary rotation decision. Cheap below the precheck ratio; above it the
 * live set is measured with a full GC and compared against the soft
 * watermark. Without --expose-gc only a raw reading at the hard watermark
 * rotates, so an uninstrumented process degrades to the old behaviour.
 */
export function heapRotationNeeded(): HeapReading | undefined {
  const raw = readHeap();
  if (raw.heapLimit <= 0 || raw.ratio < ROTATION_PRECHECK_RATIO) return undefined;
  if (!forceFullGc()) {
    return raw.ratio >= MEMORY_PRESSURE_HEAP_RATIO ? { ...raw, gcVerified: false } : undefined;
  }
  const heapUsed = process.memoryUsage().heapUsed;
  const ratio = ratioOf(raw.heapLimit, heapUsed);
  if (ratio < MEMORY_ROTATION_HEAP_RATIO) return undefined;
  return { heapUsed, heapLimit: raw.heapLimit, ratio, verifiedRatio: ratio, gcVerified: true };
}

/** Whether a rotation should also leave a .heapsnapshot retainer trail. */
export function heapSnapshotWarranted(reading: HeapReading): boolean {
  if (process.env.FLAVOR_HEAP_SNAPSHOT_ON_ROTATE === "1") return true;
  return (reading.verifiedRatio ?? reading.ratio) >= SNAPSHOT_HEAP_RATIO;
}
