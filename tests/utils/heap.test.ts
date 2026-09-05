import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  MEMORY_PRESSURE_HEAP_RATIO,
  MEMORY_ROTATION_HEAP_RATIO,
  heapRotationNeeded,
  heapSnapshotWarranted,
  readHeap,
  verifiedHeapPressure,
  type HeapReading,
} from "../../src/utils/heap.js";

const HEAP_LIMIT = 1_000_000_000;

vi.mock("node:v8", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:v8")>();
  return { ...actual, getHeapStatistics: () => ({ ...actual.getHeapStatistics(), heap_size_limit: HEAP_LIMIT }) };
});

let heapUsedValue = 0;
// restoreMocks: true (vitest.config.ts) restores top-level spies before each
// test, so the process.memoryUsage stub must be re-applied per test or readHeap
// would observe the real heap. The node:v8 module mock is unaffected.
beforeEach(() => {
  vi.spyOn(process, "memoryUsage").mockImplementation(() => ({
    rss: 0, heapTotal: HEAP_LIMIT, heapUsed: heapUsedValue, external: 0, arrayBuffers: 0,
  }));
});

/** Set the raw heap and, optionally, expose a gc() that collects down to afterGc. */
function setHeap(used: number, opts: { gc?: boolean; afterGc?: number } = {}): void {
  heapUsedValue = used;
  const globalWithGc = globalThis as { gc?: () => void };
  if (opts.gc === true) globalWithGc.gc = () => { heapUsedValue = opts.afterGc ?? 0; };
  else delete globalWithGc.gc;
}

afterEach(() => {
  delete (globalThis as { gc?: unknown }).gc;
  delete process.env.FLAVOR_HEAP_SNAPSHOT_ON_ROTATE;
  heapUsedValue = 0;
});

describe("readHeap", () => {
  it("reports the used/limit ratio", () => {
    setHeap(0.5 * HEAP_LIMIT);
    expect(readHeap()).toEqual({ heapUsed: 0.5 * HEAP_LIMIT, heapLimit: HEAP_LIMIT, ratio: 0.5 });
  });
});

describe("verifiedHeapPressure (hard guard)", () => {
  it("stays silent below the threshold and never pays for a GC", () => {
    setHeap(0.5 * HEAP_LIMIT, { gc: true, afterGc: 0 });
    expect(verifiedHeapPressure(MEMORY_PRESSURE_HEAP_RATIO)).toBeUndefined();
    // Garbage collection was not needed, so the heap was left untouched.
    expect(heapUsedValue).toBe(0.5 * HEAP_LIMIT);
  });

  it("dismisses pressure that was only uncollected garbage", () => {
    setHeap(0.9 * HEAP_LIMIT, { gc: true, afterGc: 0.3 * HEAP_LIMIT });
    expect(verifiedHeapPressure(MEMORY_PRESSURE_HEAP_RATIO)).toBeUndefined();
    expect(heapUsedValue).toBe(0.3 * HEAP_LIMIT);
  });

  it("reports a GC-verified reading when the live set really is over the limit", () => {
    setHeap(0.95 * HEAP_LIMIT, { gc: true, afterGc: 0.85 * HEAP_LIMIT });
    const reading = verifiedHeapPressure(MEMORY_PRESSURE_HEAP_RATIO);
    expect(reading).toMatchObject({ gcVerified: true, verifiedRatio: 0.85, heapLimit: HEAP_LIMIT });
  });

  it("falls back to the raw reading when gc is not exposed", () => {
    setHeap(0.9 * HEAP_LIMIT);
    expect(verifiedHeapPressure(MEMORY_PRESSURE_HEAP_RATIO)).toMatchObject({ gcVerified: false, ratio: 0.9 });
  });
});

describe("heapRotationNeeded (soft boundary guard)", () => {
  it("is cheap below the precheck ratio and does not force a GC", () => {
    setHeap(0.3 * HEAP_LIMIT, { gc: true, afterGc: 0 });
    expect(heapRotationNeeded()).toBeUndefined();
    expect(heapUsedValue).toBe(0.3 * HEAP_LIMIT);
  });

  it("does not rotate when a GC brings the live set under the soft watermark", () => {
    setHeap(0.7 * HEAP_LIMIT, { gc: true, afterGc: 0.5 * HEAP_LIMIT });
    expect(heapRotationNeeded()).toBeUndefined();
  });

  it("rotates when the GC-verified live set is past the soft watermark", () => {
    setHeap(0.75 * HEAP_LIMIT, { gc: true, afterGc: 0.65 * HEAP_LIMIT });
    expect(heapRotationNeeded()).toMatchObject({ gcVerified: true, verifiedRatio: 0.65 });
    expect(MEMORY_ROTATION_HEAP_RATIO).toBe(0.65 <= MEMORY_ROTATION_HEAP_RATIO ? MEMORY_ROTATION_HEAP_RATIO : 0.6);
  });

  it("degrades to the hard watermark when gc is not exposed", () => {
    setHeap(0.7 * HEAP_LIMIT);
    expect(heapRotationNeeded()).toBeUndefined();
    setHeap(0.85 * HEAP_LIMIT);
    expect(heapRotationNeeded()).toMatchObject({ gcVerified: false });
  });
});

describe("heapSnapshotWarranted", () => {
  const reading = (verifiedRatio?: number, ratio = 0.6): HeapReading => ({
    heapUsed: ratio * HEAP_LIMIT, heapLimit: HEAP_LIMIT, ratio,
    ...(verifiedRatio === undefined ? {} : { verifiedRatio }), gcVerified: verifiedRatio !== undefined,
  });

  it("dumps a snapshot only near the hard limit", () => {
    expect(heapSnapshotWarranted(reading(0.7))).toBe(false);
    expect(heapSnapshotWarranted(reading(0.9))).toBe(true);
  });

  it("always dumps under the explicit env override", () => {
    process.env.FLAVOR_HEAP_SNAPSHOT_ON_ROTATE = "1";
    expect(heapSnapshotWarranted(reading(0.65))).toBe(true);
  });
});
