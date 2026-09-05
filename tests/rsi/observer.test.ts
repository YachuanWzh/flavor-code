import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { z } from "zod";

import { HookBus } from "../../src/hooks/bus.js";
import { PermissionEngine } from "../../src/permissions/engine.js";
import { ToolOutcomeCollector } from "../../src/rsi/observer.js";
import type { RsiToolOutcome, RsiToolTerminal } from "../../src/rsi/types.js";
import { ToolRuntime } from "../../src/tools/runtime.js";
import type { ToolDefinition } from "../../src/tools/types.js";

function terminal(
  toolCallId: string,
  outcome: RsiToolOutcome,
  overrides: Partial<RsiToolTerminal> = {},
): RsiToolTerminal {
  return { sessionId: "s1", runId: "r1", toolCallId, tool: "Shell", outcome, ...overrides };
}

describe("ToolOutcomeCollector (P0-02b / E2)", () => {
  it("10 failures / 90 successes across unique calls gives a 0.10 rate", () => {
    const collector = new ToolOutcomeCollector();
    for (let i = 0; i < 90; i += 1) collector.record(terminal(`ok-${i}`, "success"));
    for (let i = 0; i < 10; i += 1) collector.record(terminal(`bad-${i}`, "failure"));
    const snap = collector.snapshot();
    expect(snap.comparableCalls).toBe(100);
    expect(snap.failureRate).toBeCloseTo(0.1);
    expect(snap.evidenceComplete).toBe(true);
  });

  it("1 failure / 1 success is 0.50 — fewer raw failures never proves improvement", () => {
    const collector = new ToolOutcomeCollector();
    collector.record(terminal("a", "failure"));
    collector.record(terminal("b", "success"));
    const snap = collector.snapshot();
    expect(snap.failureRate).toBeCloseTo(0.5);
    // Contrast: previous run was 100 calls / 10 failures (0.10). A drop to a
    // single failure is NOT an improvement signal; this is the rsi.md gap-one
    // regression case.
    expect(snap.failureRate).toBeGreaterThan(0.1);
  });

  it("no calls yields a null rate, not 0%", () => {
    const collector = new ToolOutcomeCollector();
    const snap = collector.snapshot();
    expect(snap.failureRate).toBeNull();
    expect(snap.comparableCalls).toBe(0);
  });

  it("duplicate terminal notifications for one call count once", () => {
    const collector = new ToolOutcomeCollector();
    expect(collector.record(terminal("dup", "failure"))).toBe("added");
    expect(collector.record(terminal("dup", "failure"))).toBe("duplicate");
    const snap = collector.snapshot();
    expect(snap.failure).toBe(1);
    expect(snap.comparableCalls).toBe(1);
    expect(snap.evidenceComplete).toBe(true);
  });

  it("the same toolCallId in different runs stays two separate calls", () => {
    const collector = new ToolOutcomeCollector();
    collector.record(terminal("shared", "failure", { runId: "rA" }));
    collector.record(terminal("shared", "success", { runId: "rB" }));
    const snap = collector.snapshot();
    expect(snap.comparableCalls).toBe(2);
    expect(snap.failureRate).toBeCloseTo(0.5);
  });

  it("success-then-failure for one call flags a conflict and keeps the first terminal", () => {
    const collector = new ToolOutcomeCollector();
    collector.record(terminal("flip", "success"));
    expect(collector.record(terminal("flip", "failure"))).toBe("conflict");
    const snap = collector.snapshot();
    expect(snap.conflicts).toBe(1);
    expect(snap.evidenceComplete).toBe(false);
    // Must not silently switch to the outcome favouring either side: the
    // first recording stands (1 success), the conflict is counted separately.
    expect(snap.success).toBe(1);
    expect(snap.failure).toBe(0);
  });

  it("explicit cancellations are excluded from the rate but reported", () => {
    const collector = new ToolOutcomeCollector();
    collector.record(terminal("c1", "cancelled"));
    collector.record(terminal("c2", "cancelled"));
    collector.record(terminal("f1", "failure"));
    collector.record(terminal("s1", "success"));
    const snap = collector.snapshot();
    expect(snap.cancelled).toBe(2);
    expect(snap.comparableCalls).toBe(2);
    expect(snap.failureRate).toBeCloseTo(0.5);
  });

  it("finalize returns the snapshot and releases memory for the next episode", () => {
    const collector = new ToolOutcomeCollector();
    collector.record(terminal("x", "failure"));
    const final = collector.finalize();
    expect(final.failure).toBe(1);
    expect(final.failureRate).toBe(1);
    expect(collector.snapshot().comparableCalls).toBe(0);
    expect(collector.snapshot().failureRate).toBeNull();
  });
});

describe("ToolRuntime trusted-terminal wiring (P0-02c)", () => {
  class AllowPermissions extends PermissionEngine {
    override decide() {
      return { decision: "allow" as const };
    }
  }

  function wiringFixture() {
    const workspace = mkdtempSync(join(tmpdir(), "flavor-rsi-wire-"));
    const collector = new ToolOutcomeCollector();
    const okTool: ToolDefinition<{ path: string }> = {
      name: "Ok", description: "ok", inputSchema: z.object({ path: z.string() }),
      paths: (input) => [input.path], execute: async () => "done",
    };
    const boomTool: ToolDefinition<{ path: string }> = {
      name: "Boom", description: "boom", inputSchema: z.object({ path: z.string() }),
      paths: (input) => [input.path], execute: async () => { throw new Error("tool exploded"); },
    };
    const runtime = new ToolRuntime({
      tools: [okTool, boomTool],
      hooks: new HookBus(),
      permissions: new AllowPermissions({ workspace }),
      rsi: { sessionId: () => "s-wire", runId: () => "r-wire", record: (t) => { collector.record(t); } },
    });
    return { workspace, collector, runtime };
  }

  it("records success, failure, cancellation, and unknown-tool terminals", async () => {
    const { collector, runtime } = wiringFixture();
    await expect(runtime.execute({ id: "c1", name: "Ok", input: { path: "x" } }, { agent: "main" }))
      .resolves.toMatchObject({ ok: true });
    await expect(runtime.execute({ id: "c2", name: "Boom", input: { path: "x" } }, { agent: "main" }))
      .resolves.toMatchObject({ ok: false, error: { code: "tool_error" } });
    const abort = new AbortController();
    abort.abort("user pressed esc");
    await expect(runtime.execute({ id: "c3", name: "Ok", input: { path: "x" } }, { agent: "main", signal: abort.signal }))
      .resolves.toMatchObject({ ok: false, error: { code: "cancelled" } });
    await expect(runtime.execute({ id: "c4", name: "Nope", input: {} }, { agent: "main" }))
      .resolves.toMatchObject({ ok: false, error: { code: "unknown_tool" } });

    const snap = collector.snapshot();
    expect(snap.success).toBe(1);
    expect(snap.failure).toBe(2); // boom + unknown tool
    expect(snap.cancelled).toBe(1);
    expect(snap.comparableCalls).toBe(3);
    expect(snap.evidenceComplete).toBe(true);
  });

  it("an observer fault never changes the tool's own result", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "flavor-rsi-wire-"));
    const okTool: ToolDefinition<{ path: string }> = {
      name: "Ok", description: "ok", inputSchema: z.object({ path: z.string() }),
      paths: (input) => [input.path], execute: async () => "done",
    };
    const runtime = new ToolRuntime({
      tools: [okTool],
      hooks: new HookBus(),
      permissions: new AllowPermissions({ workspace }),
      rsi: {
        sessionId: () => "s",
        runId: () => "r",
        record: () => { throw new Error("observer down"); },
      },
    });
    await expect(runtime.execute({ id: "c1", name: "Ok", input: { path: "x" } }, { agent: "main" }))
      .resolves.toMatchObject({ ok: true, output: "done" });
  });
});
