// P0 heap-OOM crash-fix regression harness.
//
// The crashed production session (session-20260828155654859-1591978c) died at
// 162,047 reported input tokens with zero compaction events over 775 messages.
// This file uses those observed boundaries to construct a repeatable mixed-load
// trajectory through the production ContextManager paths. It is intentionally
// self-contained; the real external session file is validated separately during
// incident investigation and is not claimed as a fixture here.
//
//   E1 the precise crash token count now triggers auto-compaction (and did not
//      under the old 92.8% threshold)
//   E2 a full soak mixing every leak path stays bounded and compaction fires
//      through prepareForModelCall before reaching the crash point
//   E3 legacy (pre-fix) retention behaviour vs fixed behaviour, side by side
//
// Run: npm run evidence:crash-fix

import { describe, expect, it } from "vitest";

import { DEFAULT_COMPACTION_POLICY, calculateContextPressure } from "../src/context/compaction.js";
import { ContextManager } from "../src/context/manager.js";
import { HookBus } from "../src/hooks/bus.js";

const CRASH_LAST_INPUT_TOKENS = 162_047; // usage.jsonl last line of both crashed runs
const OLD_AUTO_COMPACT_BUFFER = 13_000;  // pre-fix buffer => threshold 167,000

const mb = (bytes: number): string => `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
const charsOf = (log: ReadonlyArray<{ content: string }> | undefined): number =>
  (log ?? []).reduce((sum, item) => sum + item.content.length, 0);
const heapUsed = (): number => {
  if (typeof globalThis.gc === "function") globalThis.gc();
  return process.memoryUsage().heapUsed;
};

function createContext(overrides: Partial<ConstructorParameters<typeof ContextManager>[0]> = {}) {
  return new ContextManager({
    system: "system instructions",
    flavor: "project guidance",
    taskState: "in progress",
    compactAtChars: Number.POSITIVE_INFINITY, // force the token-based path only
    toolOutputChars: 30_000,                  // production default
    summarize: async () => "summary",
    hooks: new HookBus(),
    ...overrides,
  });
}

describe("P0 crash-fix regression evidence", () => {
  it("E1: the exact crash-session token count triggers compaction now, and never did before", () => {
    const oldPolicy = { ...DEFAULT_COMPACTION_POLICY, autoCompactBufferTokens: OLD_AUTO_COMPACT_BUFFER };
    const crashNow = calculateContextPressure(CRASH_LAST_INPUT_TOKENS, DEFAULT_COMPACTION_POLICY);
    const crashOld = calculateContextPressure(CRASH_LAST_INPUT_TOKENS, oldPolicy);

    console.log(`  [E1] crashTokens=${CRASH_LAST_INPUT_TOKENS} oldThreshold=${crashOld.autoCompactThresholdTokens} newThreshold=${crashNow.autoCompactThresholdTokens}`);
    console.log(`  [E1] oldShouldAutoCompact=${crashOld.shouldAutoCompact} newShouldAutoCompact=${crashNow.shouldAutoCompact}`);

    // Old behaviour: 167,000 threshold > 162,047 usage => never compacted, which
    // is exactly what audit.jsonl showed (zero compact events before the OOM).
    expect(crashOld.autoCompactThresholdTokens).toBe(167_000);
    expect(crashOld.shouldAutoCompact).toBe(false);
    // New behaviour: 85% of the effective window => compacts well before 162k.
    expect(crashNow.autoCompactThresholdTokens).toBe(153_000);
    expect(crashNow.shouldAutoCompact).toBe(true);
  });

  it("E2: crash-shaped synthetic soak stays bounded and auto-compacts mid-flight", async () => {
    let summarizeCalls = 0;
    let firstCompactAtTokens: number | undefined;
    const context = createContext({
      summarize: async () => { summarizeCalls += 1; return "compacted continuation summary"; },
    });

    const briefing = `Task briefing ${"-".repeat(30 * 1024)}`; // real subagent size
    const rounds = 400; // crash session: 710-775 messages, 74+ iterations
    const heapTrace: string[] = [];
    const startHeap = heapUsed();

    for (let round = 1; round <= rounds; round += 1) {
      // Leak path 1: subagent Task briefings admitted as transient system.
      if (round % 4 === 0) {
        const id = context.beginTransientSystem(`${briefing} #${round}`);
        context.endTransientSystem(id);
      }
      // Leak path 2: dynamic source grows every turn (Context update flooding).
      context.updateTaskState(`plan progress: ${"step ".repeat(round % 50)}${round}`);
      // Normal conversation growth of the crashed session.
      context.append({ role: "user", content: `instruction ${round}: ${"detail ".repeat(280)}` });
      context.append({ role: "assistant", content: `response ${round}: ${"analysis ".repeat(200)}` });

      // Production gateway behaviour: reported input tokens anchor the estimate.
      context.recordModelUsage(context.estimatedTokens());
      if (context.needsCompaction() && firstCompactAtTokens === undefined) {
        firstCompactAtTokens = context.lastRecordedInputTokens;
      }
      await context.prepareForModelCall();

      if (round % 100 === 0) heapTrace.push(`r${round}=${mb(process.memoryUsage().heapUsed)}`);
    }

    const log = context.snapshot().visibilityLog;
    const snapshotJson = JSON.stringify(context.snapshot());
    const endHeap = heapUsed();

    console.log(`  [E2] rounds=${rounds} summarizeCalls=${summarizeCalls} firstCompactAtTokens=${firstCompactAtTokens}`);
    console.log(`  [E2] visibilityLog entries=${log?.length ?? 0} chars=${mb(charsOf(log))}`);
    console.log(`  [E2] snapshotJSON=${mb(snapshotJson.length)} heap start=${mb(startHeap)} end=${mb(endHeap)} trace=${heapTrace.join(" ")}`);

    // Compaction actually fired through the real prepareForModelCall path...
    expect(summarizeCalls).toBeGreaterThanOrEqual(1);
    // ...and its first trigger happened at or below the crash-session usage.
    expect(firstCompactAtTokens ?? Number.POSITIVE_INFINITY).toBeLessThan(CRASH_LAST_INPUT_TOKENS);
    // Audit structures stay hard-bounded regardless of how long the soak runs.
    expect(log?.length ?? 0).toBeLessThanOrEqual(ContextManager.VISIBILITY_LOG_MAX_ENTRIES);
    expect(charsOf(log)).toBeLessThan(ContextManager.VISIBILITY_LOG_MAX_ENTRIES * (ContextManager.VISIBILITY_RECORD_CONTENT_LIMIT + 128));
    // Session-save serialization peak input stays small (was ~92MB pre-fix).
    expect(snapshotJson.length).toBeLessThan(4 * 1024 * 1024);
    // Heap does not grow anywhere near the ~4GB fatal limit over the soak.
    expect(endHeap - startHeap).toBeLessThan(200 * 1024 * 1024);
  }, 300_000);

  it("E3: legacy unbounded retention vs fixed retention on identical input", () => {
    const runs = 3_000; // far beyond the crashed session's subagent count
    const briefing = "b".repeat(30 * 1024);

    // Legacy behaviour simulation: exactly what pre-fix code kept alive --
    // one unbounded array entry per admission, serialized in full on save.
    const legacyStart = heapUsed();
    const legacyLog: Array<{ content: string }> = [];
    for (let index = 0; index < runs; index += 1) legacyLog.push({ content: `${briefing} #${index}` });
    const legacySave = JSON.stringify({ visibilityLog: legacyLog });
    const legacyRetention = heapUsed() - legacyStart;

    // Fixed behaviour: identical admissions through the real manager.
    const context = createContext();
    const fixedStart = heapUsed();
    for (let index = 0; index < runs; index += 1) {
      const id = context.beginTransientSystem(briefing);
      context.endTransientSystem(id);
    }
    const fixedSave = JSON.stringify(context.snapshot());
    const fixedRetention = heapUsed() - fixedStart;

    console.log(`  [E3] runs=${runs} legacyRetention=${mb(legacyRetention)} fixedRetention=${mb(fixedRetention)}`);
    console.log(`  [E3] legacySavePeak=${mb(legacySave.length)} fixedSavePeak=${mb(fixedSave.length)}`);

    // Keep the sanity floor below allocator/platform variance; the ratio below
    // is the actual regression signal.
    expect(legacyRetention).toBeGreaterThan(64 * 1024 * 1024);
    expect(fixedRetention).toBeLessThan(legacyRetention / 8);
    expect(fixedSave.length).toBeLessThan(legacySave.length / 8);
    expect(charsOf(context.snapshot().visibilityLog)).toBeLessThan(4 * 1024 * 1024);
  }, 300_000);
});
