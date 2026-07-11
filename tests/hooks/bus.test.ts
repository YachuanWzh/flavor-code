import { describe, expect, it } from "vitest";

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

  it("applies per-handler timeouts", async () => {
    const bus = new HookBus();
    bus.on("PreToolUse", async (_event, signal) => {
      await new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
      return { decision: "allow" };
    }, { timeoutMs: 5 });

    await expect(bus.emit({ version: 1, type: "PreToolUse", payload: {} })).rejects.toThrow();
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
