import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { HeapReading } from "../../src/utils/heap.js";
import {
  censusHeapBlock,
  writeRotationCensus,
  writeRotationHeapSnapshot,
  type RotationCensus,
} from "../../src/utils/rotation-census.js";

// Keep the heap snapshot cheap: a real v8.writeHeapSnapshot dumps the whole
// test-process heap to disk, which is slow and writes hundreds of megabytes.
// The stub still creates a tiny file so prune() has real entries to rotate.
const snapshotPaths: string[] = [];
vi.mock("node:v8", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:v8")>();
  const { writeFileSync } = await import("node:fs");
  return {
    ...actual,
    writeHeapSnapshot: (path: string) => {
      writeFileSync(path, "stub-snapshot", "utf8");
      snapshotPaths.push(path);
      return path;
    },
  };
});

const roots: string[] = [];

afterEach(async () => {
  snapshotPaths.length = 0;
  vi.useRealTimers();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "flavor-census-"));
  roots.push(root);
  return root;
}

type ReadingOverrides = {
  heapUsed?: number;
  heapLimit?: number;
  ratio?: number;
  verifiedRatio?: number | undefined;
  gcVerified?: boolean;
};

function reading(overrides: ReadingOverrides = {}): HeapReading {
  const { heapUsed = 1_200_000_000, heapLimit = 2_000_000_000, ratio = 0.6, gcVerified = true } = overrides;
  // Distinguish "omitted" from an explicit undefined (exactOptionalPropertyTypes).
  const verifiedRatio = "verifiedRatio" in overrides ? overrides.verifiedRatio : 0.62;
  return {
    heapUsed,
    heapLimit,
    ratio,
    gcVerified,
    ...(verifiedRatio === undefined ? {} : { verifiedRatio }),
  };
}

function census(overrides: Partial<RotationCensus> = {}): RotationCensus {
  return {
    at: "2026-08-25T00:00:00.000Z",
    reason: "rotation",
    sessionId: "session-test",
    heap: censusHeapBlock(reading()),
    holders: { context: { entries: 3, chars: 900 }, jobs: { entries: 1, bytes: 64 } },
    ...overrides,
  };
}

describe("censusHeapBlock", () => {
  it("converts the reading to rounded megabytes and keeps the verified ratio", () => {
    const block = censusHeapBlock(reading({ heapUsed: 3_442_000_000, heapLimit: 4_288_000_000, ratio: 0.802, verifiedRatio: 0.791 }));
    expect(block).toMatchObject({
      heapUsedMb: Math.round(3_442_000_000 / 1_048_576),
      heapLimitMb: Math.round(4_288_000_000 / 1_048_576),
      rawRatio: 0.802,
      verifiedRatio: 0.791,
      gcVerified: true,
    });
    expect(block.rssMb).toBeGreaterThanOrEqual(0);
    expect(block.externalMb).toBeGreaterThanOrEqual(0);
  });

  it("omits verifiedRatio when the reading was not GC-verified", () => {
    const block = censusHeapBlock(reading({ verifiedRatio: undefined, gcVerified: false }));
    expect(block.gcVerified).toBe(false);
    expect("verifiedRatio" in block).toBe(false);
  });
});

describe("writeRotationCensus", () => {
  it("writes a bounded, readable census under .flavor/tmp", async () => {
    const root = await workspace();
    const path = writeRotationCensus(root, census());
    expect(path).toBeDefined();
    expect(path).toContain(join(".flavor", "tmp"));
    const parsed = JSON.parse(await readFile(path!, "utf8")) as RotationCensus;
    expect(parsed.sessionId).toBe("session-test");
    expect(parsed.holders.context).toMatchObject({ entries: 3, chars: 900 });
  });

  it("keeps only the five most recent censuses", async () => {
    const root = await workspace();
    const directory = join(root, ".flavor", "tmp");
    // Distinct timestamps so prune (which sorts by name) has a real ordering.
    let clock = 1_000_000_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => (clock += 1_000));
    for (let index = 0; index < 8; index += 1) {
      expect(writeRotationCensus(root, census())).toBeDefined();
    }
    const remaining = (await readdir(directory)).filter((name) => name.startsWith("rotation-census-"));
    expect(remaining).toHaveLength(5);
    // The newest five survive; the three oldest were pruned.
    expect(remaining.sort().at(-1)).toContain(String(clock));
  });
});

describe("writeRotationHeapSnapshot", () => {
  it("writes a .heapsnapshot under .flavor/tmp and prunes to two", async () => {
    const root = await workspace();
    const directory = join(root, ".flavor", "tmp");
    let clock = 2_000_000_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => (clock += 1_000));
    for (let index = 0; index < 4; index += 1) {
      expect(writeRotationHeapSnapshot(root)).toBeDefined();
    }
    expect(snapshotPaths).toHaveLength(4);
    const remaining = (await readdir(directory)).filter((name) => name.endsWith(".heapsnapshot"));
    expect(remaining).toHaveLength(2);
  });
});
