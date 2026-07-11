import { describe, expect, it } from "vitest";
import { z } from "zod";

import { HookBus } from "../../src/hooks/bus.js";
import { HookEventSchema } from "../../src/hooks/types.js";

describe("HookBus", () => {
  it("runs handlers in registration order and stops on deny", async () => {
    const calls: string[] = [];
    const bus = new HookBus();
    bus.on("PreToolUse", async () => { calls.push("first"); return { decision: "allow" }; });
    bus.on("PreToolUse", async () => { calls.push("second"); return { decision: "deny", reason: "policy" }; });
    bus.on("PreToolUse", async () => { calls.push("third"); return { decision: "allow" }; });

    expect(await bus.emit({ version: 1, type: "PreToolUse", payload: {} })).toMatchObject({ decision: "deny" });
    expect(calls).toEqual(["first", "second"]);
  });

  it("propagates ask and validated input updates", async () => {
    const bus = new HookBus();
    bus.on("PreToolUse", async () => ({ decision: "allow", updatedInput: { tool: "Read" } }));
    bus.on("PreToolUse", async (event) => ({
      decision: "ask",
      reason: (event.payload as { tool: string }).tool,
    }));

    expect(await bus.emit({ version: 1, type: "PreToolUse", payload: {} })).toEqual({
      decision: "ask",
      reason: "Read",
      updatedInput: { tool: "Read" },
    });
  });

  it("rejects invalid modified input", async () => {
    const bus = new HookBus();
    bus.on("PreToolUse", async () => ({ decision: "allow", updatedInput: "invalid" }));

    await expect(bus.emit({ version: 1, type: "PreToolUse", payload: {} })).rejects.toThrow();
  });

  it("validates modified input against the event-specific payload schema", async () => {
    const bus = new HookBus();
    bus.registerPayloadSchema("PreToolUse", z.object({ tool: z.string(), input: z.object({ path: z.string() }) }));
    bus.on("PreToolUse", async () => ({ decision: "allow", updatedInput: { tool: "Read", input: { path: 42 } } }));

    await expect(bus.emit({ version: 1, type: "PreToolUse", payload: { tool: "Read", input: { path: "ok" } } })).rejects.toThrow();
  });

  it("does not let an older payload-schema disposer remove its replacement", async () => {
    const bus = new HookBus();
    const disposeFirst = bus.registerPayloadSchema("PreToolUse", z.object({ first: z.string() }));
    const disposeSecond = bus.registerPayloadSchema("PreToolUse", z.object({ second: z.string() }));
    disposeFirst();

    await expect(bus.emit({ version: 1, type: "PreToolUse", payload: { first: "stale" } })).rejects.toThrow();
    await expect(bus.emit({ version: 1, type: "PreToolUse", payload: { second: "current" } })).resolves.toMatchObject({ decision: "allow" });
    disposeSecond();
  });

  it("restores stacked payload schemas and tracks identical owners independently", async () => {
    const bus = new HookBus();
    const first = z.object({ first: z.string() });
    const second = z.object({ second: z.string() });
    const disposeFirst = bus.registerPayloadSchema("PreToolUse", first);
    const disposeSecond = bus.registerPayloadSchema("PreToolUse", second);

    await expect(bus.emit({ version: 1, type: "PreToolUse", payload: { first: "hidden" } })).rejects.toThrow();
    disposeSecond();
    await expect(bus.emit({ version: 1, type: "PreToolUse", payload: { second: "removed" } })).rejects.toThrow();
    await expect(bus.emit({ version: 1, type: "PreToolUse", payload: { first: "restored" } })).resolves.toMatchObject({ decision: "allow" });

    const disposeIdentical = bus.registerPayloadSchema("PreToolUse", first);
    disposeIdentical();
    await expect(bus.emit({ version: 1, type: "PreToolUse", payload: { second: "still invalid" } })).rejects.toThrow();
    disposeFirst();
    await expect(bus.emit({ version: 1, type: "PreToolUse", payload: { unrestricted: true } })).resolves.toMatchObject({ decision: "allow" });
  });

  it("preserves all accumulated context through ask and deny", async () => {
    const bus = new HookBus();
    bus.on("PreToolUse", async () => ({ decision: "allow", additionalContext: "one" }));
    bus.on("PreToolUse", async () => ({ decision: "ask", additionalContext: "two" }));
    bus.on("PreToolUse", async () => ({ decision: "deny", additionalContext: "three" }));

    expect(await bus.emit({ version: 1, type: "PreToolUse", payload: {} })).toMatchObject({
      decision: "deny",
      additionalContext: "one\ntwo\nthree",
    });
  });

  it("applies per-handler timeouts", async () => {
    const bus = new HookBus();
    bus.on("PreToolUse", async (_event, signal) => {
      await new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
      return { decision: "allow" };
    }, { timeoutMs: 5 });

    await expect(bus.emit({ version: 1, type: "PreToolUse", payload: {} })).rejects.toThrow();
  });

  it("passes an abort signal and ignores a late plugin result", async () => {
    const bus = new HookBus();
    let signalAborted = false;
    bus.on("PreToolUse", async (_event, signal) => {
      signal.addEventListener("abort", () => { signalAborted = true; });
      await new Promise((resolve) => setTimeout(resolve, 30));
      return { decision: "allow", updatedInput: { late: true } };
    }, { timeoutMs: 5, failurePolicy: "deny" });

    const decision = await bus.emit({ version: 1, type: "PreToolUse", payload: {} });
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(signalAborted).toBe(true);
    expect(decision).toMatchObject({ decision: "deny" });
    expect(decision).not.toHaveProperty("updatedInput");
  });

  it("runs shell handlers and applies their failure policy", async () => {
    const bus = new HookBus();
    bus.on("PreToolUse", {
      command: process.execPath,
      args: ["-e", "process.stdin.resume(); process.stdin.on('end',()=>process.stdout.write(JSON.stringify({decision:'allow'})))"],
    });
    bus.on("PreToolUse", {
      command: process.execPath,
      args: ["-e", "process.exit(2)"],
      failurePolicy: "ask",
    });

    expect(await bus.emit({ version: 1, type: "PreToolUse", payload: {} })).toMatchObject({ decision: "ask" });
  });

  it("terminates timed-out shell handlers and bounds their output", async () => {
    const timedOut = new HookBus();
    timedOut.on("PreToolUse", {
      command: process.execPath,
      args: ["-e", "setInterval(()=>{}, 1000)"],
      timeoutMs: 20,
      failurePolicy: "deny",
    });
    expect(await timedOut.emit({ version: 1, type: "PreToolUse", payload: {} })).toMatchObject({ decision: "deny" });

    const noisy = new HookBus();
    noisy.on("PreToolUse", {
      command: process.execPath,
      args: ["-e", "process.stdout.write('x'.repeat(1000))"],
      maxOutputBytes: 32,
      failurePolicy: "deny",
    });
    expect(await noisy.emit({ version: 1, type: "PreToolUse", payload: {} })).toMatchObject({
      decision: "deny",
      reason: expect.stringContaining("output limit"),
    });
  });

  it("accepts every approved event and rejects unknown names", () => {
    const names = [
      "SessionStart", "UserPromptSubmit", "Stop", "SessionEnd",
      "BeforePlan", "AfterPlan", "SubagentStart", "SubagentStop",
      "BeforeModelCall", "AfterModelCall", "PreToolUse", "PermissionRequest",
      "PostToolUse", "PostToolUseFailure", "PreCompact", "PostCompact",
      "PluginLoad", "PluginUnload", "Notification",
    ];
    for (const type of names) {
      expect(HookEventSchema.safeParse({ version: 1, type, payload: {} }).success).toBe(true);
    }
    expect(HookEventSchema.safeParse({ version: 1, type: "Unknown", payload: {} }).success).toBe(false);
  });
});
