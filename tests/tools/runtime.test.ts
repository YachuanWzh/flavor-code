import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { HookBus } from "../../src/hooks/bus.js";
import { PermissionEngine } from "../../src/permissions/engine.js";
import { ToolRuntime } from "../../src/tools/runtime.js";
import type { ToolDefinition } from "../../src/tools/types.js";
import { createShellTool } from "../../src/tools/shell.js";

class RecordingPermissions extends PermissionEngine {
  constructor(workspace: string, readonly calls: string[], private readonly result: "allow" | "deny" | "ask" = "allow") {
    super({ workspace });
  }

  override decide() {
    this.calls.push("permission");
    return this.result === "allow" ? { decision: "allow" as const } : { decision: this.result, reason: "policy" };
  }
}

function fixture(decision: "allow" | "deny" | "ask" = "allow") {
  const calls: string[] = [];
  const workspace = mkdtempSync(join(tmpdir(), "flavor-runtime-"));
  const hooks = new HookBus();
  hooks.on("PreToolUse", () => { calls.push("pre"); return { decision: "allow" }; });
  hooks.on("PostToolUse", () => { calls.push("post"); return { decision: "allow" }; });
  hooks.on("PostToolUseFailure", () => { calls.push("failure"); return { decision: "allow" }; });
  const tool: ToolDefinition<{ path: string }> = {
    name: "Test",
    description: "test tool",
    inputSchema: z.object({ path: z.string() }),
    paths: (input) => [input.path],
    execute: async () => { calls.push("execute"); return "done"; },
  };
  return { calls, workspace, hooks, tool, permissions: new RecordingPermissions(workspace, calls, decision) };
}

describe("ToolRuntime", () => {
  it("denies a destructive shell call using command and argument metadata", async () => {
    const f = fixture();
    const runtime = new ToolRuntime({
      tools: [createShellTool(f.workspace)], hooks: f.hooks,
      permissions: new PermissionEngine({ workspace: f.workspace, mode: "full" }),
    });

    const result = await runtime.execute(
      { name: "Shell", input: { command: "rm", args: ["-rf", "/"], cwd: "." } },
      { agent: "main" },
    );

    expect(result).toMatchObject({ ok: false, error: { code: "permission_denied" } });
  });

  it("allows a routine subagent shell call with an explicit normalized cwd", async () => {
    const f = fixture();
    const routineShell: ToolDefinition<{ command: string; args: string[]; cwd: string }> = {
      name: "Shell",
      description: "test shell metadata",
      inputSchema: z.object({ command: z.string(), args: z.array(z.string()), cwd: z.string() }),
      paths: (input) => [join(f.workspace, input.cwd)],
      permissions: (input) => ({
        paths: [join(f.workspace, input.cwd)], command: input.command, args: input.args, cwd: join(f.workspace, input.cwd),
      }),
      execute: async () => "assessed",
    };
    const runtime = new ToolRuntime({
      tools: [routineShell], hooks: f.hooks,
      permissions: new PermissionEngine({ workspace: f.workspace, mode: "workspace" }),
    });

    const result = await runtime.execute(
      { name: "Shell", input: { command: "npm", args: ["test"], cwd: "." } },
      { agent: "subagent" },
    );

    expect(result).toEqual({ ok: true, output: "assessed" });
  });
  it("runs pre-hook, permission, tool, and post-hook in order", async () => {
    const f = fixture();
    const runtime = new ToolRuntime({ tools: [f.tool], hooks: f.hooks, permissions: f.permissions });

    await expect(runtime.execute({ name: "Test", input: { path: join(f.workspace, "x") } }, { agent: "main" }))
      .resolves.toEqual({ ok: true, output: "done" });
    expect(f.calls).toEqual(["pre", "permission", "execute", "post"]);
  });

  it("denies without executing and emits a failure hook", async () => {
    const f = fixture("deny");
    const runtime = new ToolRuntime({ tools: [f.tool], hooks: f.hooks, permissions: f.permissions });

    await expect(runtime.execute({ name: "Test", input: { path: join(f.workspace, "x") } }, { agent: "main" }))
      .resolves.toMatchObject({ ok: false, error: { code: "permission_denied", message: "policy" } });
    expect(f.calls).toEqual(["pre", "permission", "failure"]);
  });

  it("asks for approval only for the main agent", async () => {
    const main = fixture("ask");
    let approvals = 0;
    const runtime = new ToolRuntime({
      tools: [main.tool], hooks: main.hooks, permissions: main.permissions,
      approve: async () => { approvals += 1; return true; },
    });
    expect((await runtime.execute({ name: "Test", input: { path: join(main.workspace, "x") } }, { agent: "main" })).ok).toBe(true);
    expect(approvals).toBe(1);

    const sub = fixture("ask");
    const subRuntime = new ToolRuntime({
      tools: [sub.tool], hooks: sub.hooks, permissions: sub.permissions,
      approve: async () => { approvals += 1; return true; },
    });
    await expect(subRuntime.execute({ name: "Test", input: { path: join(sub.workspace, "x") } }, { agent: "subagent" }))
      .resolves.toMatchObject({ ok: false, error: { code: "approval_required" } });
    expect(approvals).toBe(1);
  });

  it("combines pre-hook and permission asks into one ordered approval", async () => {
    const f = fixture("ask");
    f.hooks.on("PreToolUse", () => ({ decision: "ask", reason: "pre asks" }));
    f.hooks.on("PermissionRequest", () => { f.calls.push("request"); return { decision: "allow" }; });
    const runtime = new ToolRuntime({
      tools: [f.tool], hooks: f.hooks, permissions: f.permissions,
      approve: async () => { f.calls.push("approval"); return true; },
    });

    await expect(runtime.execute({ name: "Test", input: { path: join(f.workspace, "x") } }, { agent: "main" }))
      .resolves.toMatchObject({ ok: true });
    expect(f.calls).toEqual(["pre", "permission", "request", "approval", "execute", "post"]);
  });

  it("stops when PermissionRequest denies or applies failurePolicy deny", async () => {
    for (const throwing of [false, true]) {
      const f = fixture("ask");
      f.hooks.on("PermissionRequest", () => {
        f.calls.push("request");
        if (throwing) throw new Error("request hook failed");
        return { decision: "deny", reason: "request denied" };
      }, throwing ? { failurePolicy: "deny" } : {});
      let approvals = 0;
      const runtime = new ToolRuntime({
        tools: [f.tool], hooks: f.hooks, permissions: f.permissions,
        approve: async () => { approvals += 1; return true; },
      });

      await expect(runtime.execute({ name: "Test", input: { path: join(f.workspace, "x") } }, { agent: "main" }))
        .resolves.toMatchObject({ ok: false });
      expect(f.calls).toEqual(["pre", "permission", "request", "failure"]);
      expect(approvals).toBe(0);
    }
  });

  it("never invokes approval for a subagent after PermissionRequest", async () => {
    const f = fixture("ask");
    f.hooks.on("PermissionRequest", () => { f.calls.push("request"); return { decision: "allow" }; });
    let approvals = 0;
    const runtime = new ToolRuntime({
      tools: [f.tool], hooks: f.hooks, permissions: f.permissions,
      approve: async () => { approvals += 1; return true; },
    });

    await expect(runtime.execute({ name: "Test", input: { path: join(f.workspace, "x") } }, { agent: "subagent" }))
      .resolves.toMatchObject({ ok: false, error: { code: "approval_required" } });
    expect(f.calls).toEqual(["pre", "permission", "request", "failure"]);
    expect(approvals).toBe(0);
  });

  it("disposes its payload schemas idempotently", async () => {
    const f = fixture();
    const runtime = new ToolRuntime({ tools: [f.tool], hooks: f.hooks, permissions: f.permissions });
    await expect(f.hooks.emit({ version: 1, type: "PreToolUse", payload: { released: true } })).rejects.toThrow();

    runtime.dispose();
    runtime.dispose();

    await expect(f.hooks.emit({ version: 1, type: "PreToolUse", payload: { released: true } }))
      .resolves.toMatchObject({ decision: "allow" });
  });

  it("preserves schemas owned by another live runtime on the same bus", async () => {
    const f = fixture();
    const first = new ToolRuntime({ tools: [f.tool], hooks: f.hooks, permissions: f.permissions });
    const second = new ToolRuntime({ tools: [f.tool], hooks: f.hooks, permissions: f.permissions });

    first.dispose();
    await expect(f.hooks.emit({ version: 1, type: "PreToolUse", payload: { unrestricted: true } })).rejects.toThrow();
    second.dispose();
    await expect(f.hooks.emit({ version: 1, type: "PreToolUse", payload: { unrestricted: true } }))
      .resolves.toMatchObject({ decision: "allow" });
  });

  it("validates hook-modified input before permission and execution", async () => {
    const f = fixture();
    f.hooks.on("PreToolUse", () => ({
      decision: "allow",
      updatedInput: { tool: "Test", input: { path: 42 }, agent: "main" },
    }));
    const runtime = new ToolRuntime({ tools: [f.tool], hooks: f.hooks, permissions: f.permissions });

    await expect(runtime.execute({ name: "Test", input: { path: join(f.workspace, "x") } }, { agent: "main" }))
      .resolves.toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(f.calls).not.toContain("execute");
  });

  it("catches execution failures and emits PostToolUseFailure", async () => {
    const f = fixture();
    const failing = { ...f.tool, execute: async () => { f.calls.push("execute"); throw new Error("boom"); } };
    const runtime = new ToolRuntime({ tools: [failing], hooks: f.hooks, permissions: f.permissions });

    await expect(runtime.execute({ name: "Test", input: { path: join(f.workspace, "x") } }, { agent: "main" }))
      .resolves.toEqual({ ok: false, error: { code: "tool_error", message: "boom" } });
    expect(f.calls).toEqual(["pre", "permission", "execute", "failure"]);
  });
});
