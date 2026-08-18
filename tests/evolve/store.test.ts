import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { EvolveStore, argKeys, fingerprint, normalizeError } from "../../src/evolve/store.js";

async function fixture(maxSignals = 400) {
  const workspace = await mkdtemp(join(tmpdir(), "flavor-evolve-store-"));
  return { workspace, store: new EvolveStore({ workspace, maxSignals }) };
}

describe("normalizeError / fingerprint / argKeys", () => {
  it("normalizes whitespace, quoted values, and caps length", () => {
    const input = `  ENOENT: no such file  "C:\\temp\\a.txt"  \n   retry `;
    expect(normalizeError(input)).toBe('ENOENT: no such file "…" retry');
    const long = "x".repeat(300);
    expect(normalizeError(long)).toHaveLength(160);
  });

  it("fingerprints tool + errorCode + normalized message", () => {
    const base = fingerprint("Read", "ENOENT", "no such file");
    expect(base).toMatch(/^[0-9a-f]{12}$/u);
    expect(base).toBe(fingerprint("Read", "ENOENT", "no such file"));
    // Same tool/message but different code produces a different fingerprint.
    expect(base).not.toBe(fingerprint("Read", "EACCES", "no such file"));
    // Message normalization means equivalent messages coalesce.
    expect(fingerprint("Read", "ENOENT", 'no such file "a.txt"')).toBe(
      fingerprint("Read", "ENOENT", 'no such file "b.txt"'),
    );
  });

  it("extracts only key names, never values", () => {
    expect(argKeys({ path: "C:\\secret.txt", options: { recursive: true }, count: 3 })).toEqual([
      "path", "options", "count",
    ]);
    expect(argKeys("not an object")).toEqual([]);
    expect(argKeys(undefined)).toEqual([]);
    expect(argKeys(["a", "b"])).toEqual(["0", "1"]);
  });
});

describe("EvolveStore", () => {
  it("records a new signal and bumps count/lastAt on dedupe", async () => {
    const { workspace, store } = await fixture();
    const first = await store.recordSignal({ tool: "Read", errorCode: "ENOENT", error: "no such file", args: { path: "/x" } });
    expect(first.added).toBe(true);
    const second = await store.recordSignal({ tool: "Read", errorCode: "ENOENT", error: "no such file", args: { path: "/y" } });
    expect(second.added).toBe(false);

    const signals = await store.signals();
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({
      id: first.record.id,
      tool: "Read",
      errorCode: "ENOENT",
      error: "no such file",
      count: 2,
      args: ["path"],
    });
    expect(second.record.count).toBe(2);
    expect(signals[0]?.lastAt).toBe(second.record.lastAt);
  });

  it("keeps distinct signals for different tools and codes", async () => {
    const { store } = await fixture();
    await store.recordSignal({ tool: "Read", errorCode: "ENOENT", error: "missing" });
    await store.recordSignal({ tool: "Read", errorCode: "EACCES", error: "missing" });
    await store.recordSignal({ tool: "Write", errorCode: "ENOENT", error: "missing" });
    const signals = await store.signals();
    expect(signals).toHaveLength(3);
  });

  it("bounds the signal file at maxSignals, dropping oldest entries", async () => {
    const { workspace, store } = await fixture(3);
    for (let index = 0; index < 5; index += 1) {
      await store.recordSignal({ tool: `Tool${index}`, errorCode: "E", error: `err ${index}` });
    }
    const signals = await store.signals();
    expect(signals).toHaveLength(3);
    // The two newest entries survive; ordering is by count then lastAt.
    expect(signals.map((signal) => signal.tool).sort()).toEqual(["Tool2", "Tool3", "Tool4"]);
    const raw = await readFile(join(workspace, ".flavor", "evolve", "signals.jsonl"), "utf8");
    expect(raw.trim().split("\n")).toHaveLength(3);
  });

  it("skips corrupt lines and keeps the store readable", async () => {
    const { workspace, store } = await fixture();
    const dir = join(workspace, ".flavor", "evolve");
    await store.recordSignal({ tool: "Read", errorCode: "E", error: "ok" });
    // Manually append a corrupt line after the fact.
    const { appendFile } = await import("node:fs/promises");
    await appendFile(join(dir, "signals.jsonl"), "not-json\n", "utf8");
    const signals = await store.signals();
    expect(signals).toHaveLength(1);
  });

  it("aggregates open suggestions by threshold and excludes done ids", async () => {
    const { store } = await fixture();
    await store.recordSignal({ tool: "Read", errorCode: "ENOENT", error: "missing" });
    await store.recordSignal({ tool: "Read", errorCode: "ENOENT", error: "missing" });
    await store.recordSignal({ tool: "Glob", errorCode: "E", error: "boom" });
    await store.recordSignal({ tool: "Glob", errorCode: "E", error: "boom" });
    await store.recordSignal({ tool: "Glob", errorCode: "E", error: "boom" });

    const suggestions = await store.openSuggestions({ threshold: 2, limit: 10 });
    expect(suggestions.map((suggestion) => [suggestion.tool, suggestion.count])).toEqual([
      ["Glob", 3], ["Read", 2],
    ]);

    await store.markSuggestionDone(suggestions[0]!.id);
    const after = await store.openSuggestions({ threshold: 2, limit: 10 });
    expect(after.map((suggestion) => suggestion.tool)).toEqual(["Read"]);
  });

  it("appends reflections and returns the latest first", async () => {
    const { store } = await fixture();
    await store.appendReflection({
      iterations: 10, reason: "finished", toolCalls: 40, toolErrors: 2, steers: 0,
      totalFailures: 5, signalDelta: 0, failedTools: ["Read"],
    });
    await store.appendReflection({
      iterations: 8, reason: "error", toolCalls: 30, toolErrors: 1, steers: 0,
      totalFailures: 3, signalDelta: -2, failedTools: ["Glob"],
    });
    const reflections = await store.reflections(5);
    expect(reflections).toHaveLength(2);
    expect(reflections[0]).toMatchObject({ iterations: 8, signalDelta: -2, failedTools: ["Glob"] });
    expect(reflections[1]).toMatchObject({ iterations: 10, reason: "finished" });
  });

  it("clears signals and done markers", async () => {
    const { store } = await fixture();
    await store.recordSignal({ tool: "Read", errorCode: "E", error: "x" });
    const [suggestion] = await store.openSuggestions({ threshold: 1, limit: 10 });
    await store.markSuggestionDone(suggestion!.id);
    await store.clearSignals();
    expect(await store.signals()).toEqual([]);
    expect(await store.openSuggestions({ threshold: 1, limit: 10 })).toEqual([]);
    // Done ids are gone too, so the same signal becomes an open suggestion again.
    await store.recordSignal({ tool: "Read", errorCode: "E", error: "x" });
    expect(await store.openSuggestions({ threshold: 1, limit: 10 })).toHaveLength(1);
  });

  it("marks suggestions verified and excludes them from openSuggestions", async () => {
    const { store } = await fixture();
    await store.recordSignal({ tool: "Read", errorCode: "ENOENT", error: "missing" });
    await store.recordSignal({ tool: "Read", errorCode: "ENOENT", error: "missing" });
    const [suggestion] = await store.openSuggestions({ threshold: 2, limit: 10 });
    await store.markSuggestionVerified(suggestion!.id);
    expect(await store.verifiedIds()).toEqual([suggestion!.id]);
    expect(await store.openSuggestions({ threshold: 2, limit: 10 })).toEqual([]);
    // Done and verified are independent: a verified id is not a done id.
    await store.markSuggestionDone(suggestion!.id);
    expect(await store.verifiedIds()).toEqual([suggestion!.id]);
    expect(await store.openSuggestions({ threshold: 2, limit: 10 })).toEqual([]);
  });

  it("reopens verified suggestions when the tool is worsening again", async () => {
    const { store } = await fixture();
    await store.recordSignal({ tool: "Read", errorCode: "ENOENT", error: "missing" });
    await store.recordSignal({ tool: "Read", errorCode: "ENOENT", error: "missing" });
    const [suggestion] = await store.openSuggestions({ threshold: 2, limit: 10 });
    await store.markSuggestionVerified(suggestion!.id);

    // Stable/unknown trend keeps the verified suggestion hidden.
    expect(await store.openSuggestions({ threshold: 2, limit: 10, trends: {} })).toEqual([]);
    expect(await store.openSuggestions({ threshold: 2, limit: 10, trends: { Read: 0 } })).toEqual([]);
    // A regression reopens it with a worsening annotation.
    const reopened = await store.openSuggestions({ threshold: 2, limit: 10, trends: { Read: 1 } });
    expect(reopened.map((item) => item.id)).toEqual([suggestion!.id]);
    expect(reopened[0]?.trend).toBe("worsening");
  });

  it("clearSignals resets verified markers too", async () => {
    const { store } = await fixture();
    await store.recordSignal({ tool: "Read", errorCode: "E", error: "x" });
    const [suggestion] = await store.openSuggestions({ threshold: 1, limit: 10 });
    await store.markSuggestionVerified(suggestion!.id);
    await store.clearSignals();
    expect(await store.verifiedIds()).toEqual([]);
  });

  it("orders suggestions by trend (worsening > stable > improving) and annotates delta", async () => {
    const { store } = await fixture();
    await store.recordSignal({ tool: "Read", errorCode: "E1", error: "a" });
    await store.recordSignal({ tool: "Read", errorCode: "E1", error: "a" });
    await store.recordSignal({ tool: "Glob", errorCode: "E2", error: "b" });
    await store.recordSignal({ tool: "Glob", errorCode: "E2", error: "b" });
    await store.recordSignal({ tool: "Glob", errorCode: "E2", error: "b" });
    await store.recordSignal({ tool: "Write", errorCode: "E3", error: "c" });
    await store.recordSignal({ tool: "Write", errorCode: "E3", error: "c" });
    await store.recordSignal({ tool: "Write", errorCode: "E3", error: "c" });
    await store.recordSignal({ tool: "Write", errorCode: "E3", error: "c" });

    // Read has the smallest count but the worst trend, so it leads.
    const suggestions = await store.openSuggestions({
      threshold: 2, limit: 10, trends: { Read: 2, Glob: 0, Write: -1 },
    });
    expect(suggestions.map((suggestion) => [suggestion.tool, suggestion.trend, suggestion.delta])).toEqual([
      ["Read", "worsening", 2],
      ["Glob", "stable", 0],
      ["Write", "improving", -1],
    ]);
    // Hint text carries the trend so the model can act on it.
    expect(suggestions[0]?.hint).toContain("worsening");
    expect(suggestions[2]?.hint).toContain("improving");

    // Without trends the order falls back to count descending and no annotations.
    const plain = await store.openSuggestions({ threshold: 2, limit: 10 });
    expect(plain.map((suggestion) => [suggestion.tool, suggestion.count])).toEqual([
      ["Write", 4], ["Glob", 3], ["Read", 2],
    ]);
    expect(plain[0]?.trend).toBeUndefined();
    expect(plain[0]?.delta).toBeUndefined();
  });

  it("appends reflections with perTool trends and defaults it to empty", async () => {
    const { store } = await fixture();
    await store.appendReflection({
      iterations: 3, reason: "finished", toolCalls: 5, toolErrors: 2, steers: 0,
      totalFailures: 4, signalDelta: 0, failedTools: ["Read"],
      perTool: { Read: { failures: 2, delta: 0 } },
    });
    await store.appendReflection({
      iterations: 1, reason: "finished", toolCalls: 1, toolErrors: 0, steers: 0,
      totalFailures: 4, signalDelta: 0, failedTools: [],
    });
    const [latest, previous] = await store.reflections(5);
    expect(latest!.perTool).toEqual({});
    expect(previous!.perTool).toEqual({ Read: { failures: 2, delta: 0 } });
  });

  it("coalesces fingerprint ids even when raw text differs only by quoting", async () => {
    const { workspace, store } = await fixture();
    await store.recordSignal({ tool: "Shell", errorCode: "tool_error", error: 'ENOENT: "file one"' });
    await store.recordSignal({ tool: "Shell", errorCode: "tool_error", error: "ENOENT: `file one`" });
    await store.recordSignal({ tool: "Shell", errorCode: "tool_error", error: "ENOENT: \"file two\"" });
    const signals = await store.signals();
    expect(signals).toHaveLength(1);
    expect(signals[0]?.count).toBe(3);
    // Verify nothing secret was persisted: only key names, never values.
    await writeFile(join(workspace, "probe.txt"), "ignored", "utf8");
    const raw = await readFile(join(workspace, ".flavor", "evolve", "signals.jsonl"), "utf8");
    expect(raw).not.toContain("file one");
    expect(raw).not.toContain("file two");
  });
});
