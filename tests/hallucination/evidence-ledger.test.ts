import { describe, expect, it } from "vitest";
import {
  DEFAULT_EVALUATION_TIMEOUT_MS,
  EvidenceLedger,
} from "../../src/hallucination/index.js";

it("exports evidence-aware hallucination primitives", () => {
  expect(EvidenceLedger).toBeTypeOf("function");
  expect(DEFAULT_EVALUATION_TIMEOUT_MS).toBe(2_000);
});

describe("EvidenceLedger", () => {
  it("keeps a failed read before a successful shell fallback", () => {
    const ledger = new EvidenceLedger();
    ledger.recordCall("read-1", "Read", { path: "src/a.ts" });
    ledger.recordResult("read-1", "Read", {
      ok: false,
      error: { code: "missing", message: "not found" },
    });
    ledger.recordCall("shell-1", "Shell", { command: "Get-Content src/a.ts" });
    ledger.recordResult("shell-1", "Shell", {
      ok: true,
      output: "export const value = 1",
    });

    const snapshot = ledger.snapshot();
    expect(snapshot.text).toMatch(/Read[\s\S]*missing[\s\S]*Shell[\s\S]*success/);
    expect(snapshot.events.map((event) => event.callId)).toEqual(["read-1", "shell-1"]);
  });

  it("folds consecutive identical completed outcomes", () => {
    const ledger = new EvidenceLedger();
    for (let index = 0; index < 3; index += 1) {
      ledger.recordCall(`read-${index}`, "Read", { path: "same.ts" });
      ledger.recordResult(`read-${index}`, "Read", { ok: true, output: "same" });
    }

    const snapshot = ledger.snapshot();
    expect(snapshot.events).toHaveLength(1);
    expect(snapshot.events[0]?.repeatCount).toBe(3);
    expect(snapshot.foldedCount).toBe(2);
  });

  it("bounds event count and text while redacting sensitive values", () => {
    const ledger = new EvidenceLedger();
    for (let index = 0; index < 40; index += 1) {
      ledger.recordCall(`call-${index}`, "Read", {
        path: `${index}.ts`,
        apiKey: "sk-secret",
        password: "visible-password",
      });
      ledger.recordResult(`call-${index}`, "Read", {
        ok: true,
        output: `token=secret-${index} ${"x".repeat(500)}`,
      });
    }

    const snapshot = ledger.snapshot();
    expect(snapshot.events.length).toBeLessThanOrEqual(24);
    expect(snapshot.text.length).toBeLessThanOrEqual(6_000);
    expect(snapshot.text).not.toContain("sk-secret");
    expect(snapshot.text).not.toContain("visible-password");
    expect(snapshot.text).not.toContain("secret-39");
    expect(snapshot.text).toContain("[redacted]");
    expect(snapshot.omittedCount).toBeGreaterThan(0);
  });

  it("handles circular and deeply nested values without throwing", () => {
    const circular: Record<string, unknown> = { path: "a.ts" };
    circular.self = circular;
    circular.deep = { one: { two: { three: { four: "hidden" } } } };
    const ledger = new EvidenceLedger();

    expect(() => {
      ledger.recordCall("circular", "PluginTool", circular);
      ledger.recordResult("circular", "PluginTool", { ok: true, output: circular });
    }).not.toThrow();
    expect(ledger.snapshot().text).toContain("[circular]");
  });

  it("prioritizes failures, mutations, and verification-like events", () => {
    const ledger = new EvidenceLedger();
    const add = (id: string, toolName: string, input: unknown, ok = true) => {
      ledger.recordCall(id, toolName, input);
      ledger.recordResult(id, toolName, ok
        ? { ok: true, output: `${id} result` }
        : { ok: false, error: { code: "tool_error", message: `${id} failed` } });
    };

    add("test", "Shell", { command: "npm test" });
    add("write", "Write", { path: "src/a.ts", content: "new code" });
    add("failure", "Read", { path: "missing.ts" }, false);
    for (let index = 0; index < 30; index += 1) {
      add(`recent-${index}`, "Read", { path: `recent-${index}.ts` });
    }

    const ids = ledger.snapshot().events.map((event) => event.callId);
    expect(ids).toContain("test");
    expect(ids).toContain("write");
    expect(ids).toContain("failure");
    expect(ids).toContain("recent-29");
  });

  it("retains an old success adjacent to a retained failure", () => {
    const ledger = new EvidenceLedger();
    ledger.recordCall("old-read", "Read", { path: "src/a.ts" });
    ledger.recordResult("old-read", "Read", {
      ok: false,
      error: { code: "missing", message: "not found" },
    });
    ledger.recordCall("old-shell", "Shell", { command: "Get-Content src/a.ts" });
    ledger.recordResult("old-shell", "Shell", { ok: true, output: "recovered" });
    for (let index = 0; index < 30; index += 1) {
      ledger.recordCall(`later-${index}`, "Read", { path: `later-${index}.ts` });
      ledger.recordResult(`later-${index}`, "Read", { ok: true, output: `${index}` });
    }

    const ids = ledger.snapshot().events.map((event) => event.callId);
    expect(ids).toContain("old-read");
    expect(ids).toContain("old-shell");
  });

  it("reset clears events and pending calls", () => {
    const ledger = new EvidenceLedger();
    ledger.recordCall("pending", "Read", { path: "pending.ts" });
    ledger.recordCall("done", "Read", { path: "done.ts" });
    ledger.recordResult("done", "Read", { ok: true, output: "done" });

    ledger.reset();

    expect(ledger.snapshot()).toMatchObject({
      events: [],
      omittedCount: 0,
      foldedCount: 0,
    });
  });
});
