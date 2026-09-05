import { mkdirSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { writeHeapSnapshot } from "node:v8";

import type { HeapReading } from "./heap.js";

/**
 * Rotation forensics. Every heap rotation leaves a retention census: each
 * major in-memory holder reports its retained size, so the next recurrence
 * names its own grower instead of restarting with zero evidence. A full
 * .heapsnapshot accompanies rotations whose verified live set is near the
 * hard limit (or every rotation under FLAVOR_HEAP_SNAPSHOT_ON_ROTATE=1).
 */
export interface RotationCensusHolder {
  entries?: number;
  chars?: number;
  bytes?: number;
}

export interface RotationCensus {
  at: string;
  reason: string;
  sessionId: string;
  heap: {
    heapUsedMb: number;
    heapLimitMb: number;
    rawRatio: number;
    verifiedRatio?: number;
    gcVerified: boolean;
    rssMb: number;
    externalMb: number;
    arrayBuffersMb: number;
    memoryLimitMb?: number;
    rssRatio?: number;
  };
  holders: Record<string, RotationCensusHolder>;
}

const CENSUS_PREFIX = "rotation-census-";
const SNAPSHOT_PREFIX = "heap-";
const KEEP_CENSUS_FILES = 5;
const KEEP_SNAPSHOT_FILES = 2;

export function censusHeapBlock(reading: HeapReading): RotationCensus["heap"] {
  const usage = process.memoryUsage();
  const mb = (bytes: number): number => Math.round(bytes / 1_048_576);
  return {
    heapUsedMb: mb(reading.heapUsed),
    heapLimitMb: mb(reading.heapLimit),
    rawRatio: Number(reading.ratio.toFixed(3)),
    ...(reading.verifiedRatio === undefined ? {} : { verifiedRatio: Number(reading.verifiedRatio.toFixed(3)) }),
    gcVerified: reading.gcVerified,
    rssMb: mb(usage.rss),
    externalMb: mb(usage.external),
    arrayBuffersMb: mb(usage.arrayBuffers),
    ...(reading.memoryLimit === undefined ? {} : { memoryLimitMb: mb(reading.memoryLimit) }),
    ...(reading.rssRatio === undefined ? {} : { rssRatio: Number(reading.rssRatio.toFixed(3)) }),
  };
}

/** Best-effort: a failed census must never block the rotation itself. */
export function writeRotationCensus(workspace: string, census: RotationCensus): string | undefined {
  try {
    const directory = join(workspace, ".flavor", "tmp");
    mkdirSync(directory, { recursive: true });
    const path = join(directory, `${CENSUS_PREFIX}${Date.now()}.json`);
    writeFileSync(path, `${JSON.stringify(census, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    prune(directory, CENSUS_PREFIX, ".json", KEEP_CENSUS_FILES);
    return path;
  } catch {
    return undefined;
  }
}

/** Best-effort heap snapshot; synchronous and slow on large heaps by nature. */
export function writeRotationHeapSnapshot(workspace: string): string | undefined {
  try {
    const directory = join(workspace, ".flavor", "tmp");
    mkdirSync(directory, { recursive: true });
    const path = join(directory, `${SNAPSHOT_PREFIX}${Date.now()}.heapsnapshot`);
    writeHeapSnapshot(path);
    prune(directory, SNAPSHOT_PREFIX, ".heapsnapshot", KEEP_SNAPSHOT_FILES);
    return path;
  } catch {
    return undefined;
  }
}

function prune(directory: string, prefix: string, suffix: string, keep: number): void {
  const stale = readdirSync(directory)
    .filter((name) => name.startsWith(prefix) && name.endsWith(suffix))
    .sort()
    .slice(0, -keep);
  for (const name of stale) {
    try { unlinkSync(join(directory, name)); } catch { /* pruning is best-effort */ }
  }
}
