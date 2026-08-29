// Context memory stress harness.
//
// Mirrors the external stress-test scenarios that pinned the heap-OOM crash:
//   A  visibilityLog retention: thousands of 30KB transient admissions
//      (the Task subagent briefing path, AgentLoop.run -> beginTransientSystem)
//   A2 restoring a historically bloated visibility log from a session snapshot
//   B  dynamic source churn: per-turn task-state growth producing Context
//      update flooding + compaction storms
//   C  fork deep-copy of a ~1MB context (previously exonerated, kept as guard)
//
// Run: npm run stress:context
// Each scenario prints measured counters; assertions fail on any regression of
// the OOM fixes (unbounded log, full-text re-injection, stale update retention).

import { describe, expect, it } from "vitest";

import { ContextManager } from "../src/context/manager.js";
import { HookBus } from "../src/hooks/bus.js";
import { modelContentText } from "../src/models/types.js";

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
    compactAtChars: Number.POSITIVE_INFINITY,
    toolOutputChars: 100,
    summarize: async () => "summary",
    hooks: new HookBus(),
    ...overrides,
  });
}

describe("context memory stress", () => {
  it("scenario A: transient admissions stay bounded no matter how many runs happen", () => {
    const context = createContext();
    const briefing = `Task briefing ${"-".repeat(30 * 1024)}`; // 30KB, real subagent size
    const runs = 3_000;
    const before = heapUsed();

    for (let index = 0; index < runs; index += 1) {
      const id = context.beginTransientSystem(`${briefing} #${index}`);
      context.endTransientSystem(id);
    }

    const log = context.snapshot().visibilityLog;
    const after = heapUsed();

    // Pre-fix this was: entries=3000 chars≈92.2MB compact=false.
    console.log(`  [A] runs=${runs} visibilityLog entries=${log?.length ?? 0} chars=${mb(charsOf(log))} heapDelta=${mb(after - before)} compact=${context.snapshot().compact !== undefined}`);

    expect(log?.length ?? 0).toBeLessThanOrEqual(ContextManager.VISIBILITY_LOG_MAX_ENTRIES);
    expect(charsOf(log)).toBeLessThan(ContextManager.VISIBILITY_LOG_MAX_ENTRIES * (ContextManager.VISIBILITY_RECORD_CONTENT_LIMIT + 128));
    expect(log?.every((item) => item.content.length <= ContextManager.VISIBILITY_RECORD_CONTENT_LIMIT + 128)).toBe(true);
  }, 120_000);

  it("scenario A2: session save serialization peak stays bounded", () => {
    const context = createContext();
    const briefing = "x".repeat(30 * 1024);
    for (let index = 0; index < 3_000; index += 1) {
      const id = context.beginTransientSystem(briefing);
      context.endTransientSystem(id);
    }
    context.append({ role: "user", content: "conversation body" });

    const before = heapUsed();
    // SessionStore.save path: snapshot -> JSON.stringify of the whole document.
    const serialized = JSON.stringify(context.snapshot());
    const peak = process.memoryUsage().heapUsed;

    console.log(`  [A2] snapshot JSON=${mb(serialized.length)} serializationPeak=${mb(peak - before)}`);

    // Pre-fix the meta line alone carried ~92MB and doubled transiently.
    expect(serialized.length).toBeLessThan(8 * 1024 * 1024);
  }, 120_000);

  it("scenario A3: restoring a legacy bloated log shrinks it instead of rehydrating", () => {
    const context = createContext();
    const legacyLog = Array.from({ length: 2_000 }, (_unused, index) => ({
      id: `legacy-${index}`,
      role: "system" as const,
      content: "y".repeat(30 * 1024),
      admittedAt: new Date(0).toISOString(),
      scope: "run" as const,
    }));

    const before = heapUsed();
    context.restore({ messages: [], visibilityLog: legacyLog });
    const log = context.snapshot().visibilityLog;
    const after = heapUsed();

    console.log(`  [A3] restored entries=${log?.length ?? 0} chars=${mb(charsOf(log))} heapDelta=${mb(after - before)}`);

    expect(log?.length ?? 0).toBeLessThanOrEqual(ContextManager.VISIBILITY_LOG_MAX_ENTRIES);
    expect(charsOf(log)).toBeLessThan(ContextManager.VISIBILITY_LOG_MAX_ENTRIES * (ContextManager.VISIBILITY_RECORD_CONTENT_LIMIT + 128));
  }, 120_000);

  it("scenario B: per-turn source growth injects deltas and never floods the window", async () => {
    let state = "plan: step 0";
    let summarizeCalls = 0;
    const context = createContext({
      taskState: "plan: step 0",
      compactAtChars: 20_000, // small window so update flooding would be visible
      recentTurns: 2,
      summarize: async () => { summarizeCalls += 1; return "summary"; },
    });
    // ContextManager captured taskState by value; mirror production wiring where
    // updateTaskState feeds the dynamic source each turn.
    const turns = 300;

    for (let turn = 1; turn <= turns; turn += 1) {
      state += `\nstep ${turn}: completed audit of module-${turn}`;
      context.updateTaskState(state);
      context.append({ role: "user", content: `advance to step ${turn}` });
      context.append({ role: "assistant", content: `done step ${turn}` });
      await context.prepareForModelCall();
    }

    const updates = context.snapshot().messages.filter((message) =>
      modelContentText(message.content).startsWith("Context update [task-state]"));
    console.log(`  [B] turns=${turns} summarizeCalls=${summarizeCalls} staleTaskStateUpdates=${updates.length} heap=${mb(process.memoryUsage().heapUsed)}`);

    // Pre-fix: 213/300 compactions and 99.9% of window bytes were repeated
    // full-text Context update messages.
    expect(summarizeCalls).toBeLessThan(turns / 2);
    expect(updates.length).toBeLessThanOrEqual(1);
    // The surviving update (if any) carries only the latest tail, not the full history.
    for (const update of updates) {
      expect(modelContentText(update.content).length).toBeLessThan(state.length / 2);
    }
    // Latest state stays fully visible via the pinned source message.
    const pinned = context.messagesForModel().find((message) => modelContentText(message.content).startsWith("Task state\n"));
    expect(modelContentText(pinned?.content ?? "")).toContain(`step ${turns}`);
  }, 120_000);

  it("scenario B2: prefix-appending dynamic task state emits only the appended tail", () => {
    let taskState = "plan: initialized";
    const context = createContext({ taskState });

    const totalInjected: string[] = [];
    for (let record = 1; record <= 50; record += 1) {
      taskState += `\nstate record ${record}: ${"detail ".repeat(20)}`;
      context.updateTaskState(taskState);
      context.refreshContextSources();
      const update = context.snapshot().messages.at(-1);
      totalInjected.push(modelContentText(update?.content ?? ""));
    }

    const injectedChars = totalInjected.reduce((sum, item) => sum + item.length, 0);
    console.log(`  [B2] appendedRecords=50 fullTextSize=${mb(taskState.length)} injectedTotal=${mb(injectedChars)} avgPerUpdate=${(injectedChars / 50).toFixed(0)} chars`);

    // Pre-fix each refresh re-emitted the entire growing baseline (avg ~4KB and
    // rising); with delta injection each update carries only the appended tail.
    expect(injectedChars).toBeLessThan(taskState.length * 2);
    expect(injectedChars / 50).toBeLessThan(500);
    expect(totalInjected.every((item) => item.includes("Context update [task-state]"))).toBe(true);
  }, 120_000);

  it("scenario C: fork of a ~1MB context stays cheap (regression guard)", () => {
    const context = createContext();
    for (let index = 0; index < 200; index += 1) {
      context.append({ role: "user", content: `payload ${index} ${"z".repeat(5_000)}` });
    }

    const before = heapUsed();
    for (let index = 0; index < 50; index += 1) context.fork();
    const delta = heapUsed() - before;

    console.log(`  [C] forks=50 context≈1MB heapDelta=${mb(delta)}`);

    expect(delta).toBeLessThan(100 * 1024 * 1024);
  }, 120_000);
});
