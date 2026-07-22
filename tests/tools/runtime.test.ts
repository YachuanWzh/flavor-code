import { existsSync, mkdtempSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { HookBus } from "../../src/hooks/bus.js";
import { PermissionEngine } from "../../src/permissions/engine.js";
import { DEFAULT_TOOL_OUTPUT_LIMITS, ToolRuntime } from "../../src/tools/runtime.js";
import { withToolPresentation, type ToolDefinition } from "../../src/tools/types.js";
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
  it("uses the documented 50K per-tool and 200K per-turn defaults", () => {
    expect(DEFAULT_TOOL_OUTPUT_LIMITS).toEqual({ perToolChars: 50_000, perTurnChars: 200_000 });
  });

  it("persists a per-tool overflow and exposes only a bounded head/tail preview to hooks", async () => {
    const f = fixture();
    const complete = "abcdefghijABCDEFGHIJ";
    const observed: unknown[] = [];
    const tool = { ...f.tool, execute: async () => complete };
    f.hooks.on("PostToolUse", (event) => {
      observed.push(event.payload.output);
      return { decision: "allow" };
    });
    const runtime = new ToolRuntime({
      tools: [tool], hooks: f.hooks, permissions: f.permissions, workspace: f.workspace,
      outputLimits: { perToolChars: 10, perTurnChars: 100 },
    });

    runtime.beginTurn();
    const result = await runtime.execute(
      { name: "Test", input: { path: join(f.workspace, "large.txt") } },
      { agent: "main" },
    );

    expect(result).toMatchObject({
      ok: true,
      output: {
        truncated: true,
        reason: "per_tool_limit",
        preview: "abcdeFGHIJ",
        originalChars: 20,
        previewChars: 10,
        savedTo: expect.stringContaining(join(".flavor", "tool-results")),
      },
    });
    expect(observed.at(-1)).toEqual(result.output);
    const savedTo = (result.output as { savedTo: string }).savedTo;
    await expect(readFile(savedTo, "utf8")).resolves.toBe(complete);
  });

  it("shares the aggregate budget within a turn and resets it for the next turn", async () => {
    const f = fixture();
    const tool = { ...f.tool, execute: async () => "abcdefgh" };
    const runtime = new ToolRuntime({
      tools: [tool], hooks: f.hooks, permissions: f.permissions, workspace: f.workspace,
      outputLimits: { perToolChars: 10, perTurnChars: 12 },
    });
    const call = { name: "Test", input: { path: join(f.workspace, "aggregate.txt") } };

    runtime.beginTurn();
    await expect(runtime.execute(call, { agent: "main" })).resolves.toEqual({ ok: true, output: "abcdefgh" });
    await expect(runtime.execute(call, { agent: "main" })).resolves.toMatchObject({
      ok: true,
      output: {
        truncated: true,
        reason: "turn_limit",
        preview: "abgh",
        originalChars: 8,
        previewChars: 4,
      },
    });
    const exhausted = await runtime.execute(call, { agent: "main" });
    expect(exhausted).toMatchObject({
      ok: true,
      output: {
        truncated: true,
        reason: "turn_limit",
        preview: "",
        originalChars: 8,
        previewChars: 0,
        savedTo: expect.stringContaining(join(".flavor", "tool-results")),
      },
    });
    await expect(readFile((exhausted.output as { savedTo: string }).savedTo, "utf8")).resolves.toBe("abcdefgh");

    runtime.beginTurn();
    await expect(runtime.execute(call, { agent: "main" })).resolves.toEqual({ ok: true, output: "abcdefgh" });
  });

  it("does not create overflow storage for results within both limits", async () => {
    const f = fixture();
    const runtime = new ToolRuntime({
      tools: [f.tool], hooks: f.hooks, permissions: f.permissions, workspace: f.workspace,
      outputLimits: { perToolChars: 10, perTurnChars: 20 },
    });

    runtime.beginTurn();
    await expect(runtime.execute(
      { name: "Test", input: { path: join(f.workspace, "small.txt") } }, { agent: "main" },
    )).resolves.toEqual({ ok: true, output: "done" });
    const overflowDirectory = join(f.workspace, ".flavor", "tool-results");
    expect(existsSync(overflowDirectory) ? await readdir(overflowDirectory) : []).toEqual([]);
  });

  it("rejects invalid output limits", () => {
    const f = fixture();
    expect(() => new ToolRuntime({
      tools: [f.tool], hooks: f.hooks, permissions: f.permissions,
      outputLimits: { perToolChars: 0 },
    })).toThrow(/perToolChars.*positive integer/);
    expect(() => new ToolRuntime({
      tools: [f.tool], hooks: f.hooks, permissions: f.permissions,
      outputLimits: { perTurnChars: 1.5 },
    })).toThrow(/perTurnChars.*positive integer/);
  });

  it("uses auto classification for unresolved main-agent permission decisions", async () => {
    const f = fixture();
    let executions = 0;
    const tool = { ...f.tool, name: "WebFetch", execute: async () => { executions += 1; return "done"; } };
    const decisions = ["allow", "deny"] as const;
    let classifications = 0;
    const runtime = new ToolRuntime({
      tools: [tool], hooks: f.hooks,
      permissions: new PermissionEngine({ workspace: f.workspace, mode: "auto" }),
      classify: async () => ({ decision: decisions[classifications++] ?? "ask", reason: "classified" }),
    });

    await expect(runtime.execute({ name: "WebFetch", input: { path: "https://example.com" } }, { agent: "main" }))
      .resolves.toMatchObject({ ok: true });
    await expect(runtime.execute({ name: "WebFetch", input: { path: "https://example.com" } }, { agent: "main" }))
      .resolves.toMatchObject({ ok: false, error: { code: "permission_denied" } });
    expect(classifications).toBe(2);
    expect(executions).toBe(1);
  });

  it("never sends deterministically forbidden commands to the auto classifier", async () => {
    const f = fixture();
    let classifications = 0;
    const runtime = new ToolRuntime({
      tools: [createShellTool(f.workspace)], hooks: f.hooks,
      permissions: new PermissionEngine({ workspace: f.workspace, mode: "auto" }),
      classify: async () => { classifications += 1; return { decision: "allow" }; },
    });

    await expect(runtime.execute(
      { name: "Shell", input: { command: "rm", args: ["-rf", "/"], cwd: "." } },
      { agent: "main" },
    )).resolves.toMatchObject({ ok: false, error: { code: "permission_denied" } });
    expect(classifications).toBe(0);
  });

  it("falls back to normal approval when auto classification is unavailable", async () => {
    const f = fixture();
    const tool = { ...f.tool, name: "WebFetch" };
    let approvals = 0;
    const runtime = new ToolRuntime({
      tools: [tool], hooks: f.hooks,
      permissions: new PermissionEngine({ workspace: f.workspace, mode: "auto" }),
      classify: async () => { throw new Error("classifier offline"); },
      approve: async () => { approvals += 1; return "once" as const; },
    });

    await expect(runtime.execute({ name: "WebFetch", input: { path: "https://example.com" } }, { agent: "main" }))
      .resolves.toMatchObject({ ok: true });
    expect(approvals).toBe(1);
  });

  it("bubbles subagent approval requests through the parent approval callback", async () => {
    const f = fixture();
    let approvals = 0;
    const runtime = new ToolRuntime({
      tools: [f.tool], hooks: f.hooks,
      permissions: new PermissionEngine({ workspace: f.workspace, mode: "bubble" }),
      approve: async () => { approvals += 1; return "once" as const; },
    });

    await expect(runtime.execute(
      { name: "Test", input: { path: join(f.workspace, "x") } },
      { agent: "subagent" },
    )).resolves.toMatchObject({ ok: true });
    expect(approvals).toBe(1);
  });
  it("exposes and validates a tool definition without side effects", () => {
    const f = fixture();
    const runtime = new ToolRuntime({ tools: [f.tool], hooks: f.hooks, permissions: f.permissions });

    expect(runtime.definition("Test")).toMatchObject({
      name: "Test",
      description: "test tool",
      inputSchema: f.tool.inputSchema,
    });
    expect(runtime.definition("Missing")).toBeUndefined();
    expect(runtime.validate({ name: "Test", input: { path: "notes.md" } })).toEqual({
      ok: true,
      input: { path: "notes.md" },
    });
    expect(runtime.validate({ name: "Test", input: { path: 42 } })).toMatchObject({
      ok: false,
      error: { code: "invalid_input", message: expect.stringMatching(/path|string/i) },
    });
    expect(f.calls).toEqual([]);
  });

  it("exposes presentation metadata without adding it to serialized tool output", async () => {
    const f = fixture();
    const presentation = {
      kind: "file-change" as const,
      operation: "update" as const,
      path: join(f.workspace, "notes.md"),
      added: 1,
      removed: 1,
      lines: [],
    };
    const tool = {
      ...f.tool,
      execute: async () => withToolPresentation({ path: presentation.path, replacements: 1 }, presentation),
    };
    const runtime = new ToolRuntime({ tools: [tool], hooks: f.hooks, permissions: f.permissions });

    const result = await runtime.execute(
      { name: "Test", input: { path: presentation.path } },
      { agent: "main" },
    );

    expect(result.presentation).toEqual(presentation);
    expect(JSON.stringify(result.output)).toBe(JSON.stringify({ path: presentation.path, replacements: 1 }));
  });

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
      approve: async () => { approvals += 1; return "once" as const; },
    });
    expect((await runtime.execute({ name: "Test", input: { path: join(main.workspace, "x") } }, { agent: "main" })).ok).toBe(true);
    expect(approvals).toBe(1);

    const sub = fixture("ask");
    const subRuntime = new ToolRuntime({
      tools: [sub.tool], hooks: sub.hooks, permissions: sub.permissions,
      approve: async () => { approvals += 1; return "once" as const; },
    });
    await expect(subRuntime.execute({ name: "Test", input: { path: join(sub.workspace, "x") } }, { agent: "subagent" }))
      .resolves.toMatchObject({ ok: false, error: { code: "approval_required" } });
    expect(approvals).toBe(1);
  });

  it("passes cancellation into approval and completes without executing", async () => {
    const f = fixture("ask"); const controller = new AbortController();
    const runtime = new ToolRuntime({ tools: [f.tool], hooks: f.hooks, permissions: f.permissions,
      approve: async (_request, signal) => new Promise<import('../../src/tools/runtime.js').ApprovalDecision>((resolve) => {
        signal.addEventListener("abort", () => resolve("deny"), { once: true });
      }),
    });
    const pending = runtime.execute({ name: "Test", input: { path: join(f.workspace, "x") } },
      { agent: "main", signal: controller.signal });
    controller.abort(new Error("cancel"));
    await expect(pending).resolves.toMatchObject({ ok: false });
    expect(f.calls).not.toContain("execute");
  });

  it("combines pre-hook and permission asks into one ordered approval", async () => {
    const f = fixture("ask");
    f.hooks.on("PreToolUse", () => ({ decision: "ask", reason: "pre asks" }));
    f.hooks.on("PermissionRequest", () => { f.calls.push("request"); return { decision: "allow" }; });
    const runtime = new ToolRuntime({
      tools: [f.tool], hooks: f.hooks, permissions: f.permissions,
      approve: async () => { f.calls.push("approval"); return "once" as const; },
    });

    await expect(runtime.execute({ name: "Test", input: { path: join(f.workspace, "x") } }, { agent: "main" }))
      .resolves.toMatchObject({ ok: true });
    expect(f.calls).toEqual(["pre", "permission", "request", "execute", "post"]);
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
        approve: async () => { approvals += 1; return "once" as const; },
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
      approve: async () => { approvals += 1; return "once" as const; },
    });

    await expect(runtime.execute({ name: "Test", input: { path: join(f.workspace, "x") } }, { agent: "subagent" }))
      .resolves.toMatchObject({ ok: true });
    expect(f.calls).toEqual(["pre", "permission", "request", "execute", "post"]);
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

  it("bypasses approval for tools previously marked always-allowed", async () => {
    const f = fixture("ask");
    let approvals = 0;
    const runtime = new ToolRuntime({
      tools: [f.tool], hooks: f.hooks, permissions: f.permissions,
      approve: async () => { approvals += 1; return "always" as const; },
    });
    // First call: approval asked, user says "always"
    await expect(runtime.execute({ name: "Test", input: { path: join(f.workspace, "x") } }, { agent: "main" }))
      .resolves.toMatchObject({ ok: true });
    expect(approvals).toBe(1);

    // Second call with same tool: approval bypassed
    await expect(runtime.execute({ name: "Test", input: { path: join(f.workspace, "y") } }, { agent: "main" }))
      .resolves.toMatchObject({ ok: true });
    expect(approvals).toBe(1);
  });

  it("asks again when previous approval was once, not always", async () => {
    const f = fixture("ask");
    let approvals = 0;
    const runtime = new ToolRuntime({
      tools: [f.tool], hooks: f.hooks, permissions: f.permissions,
      approve: async () => { approvals += 1; return "once" as const; },
    });
    // First call: approval asked, user says "once"
    await expect(runtime.execute({ name: "Test", input: { path: join(f.workspace, "x") } }, { agent: "main" }))
      .resolves.toMatchObject({ ok: true });
    expect(approvals).toBe(1);

    // Second call: same tool, approval asked again
    await expect(runtime.execute({ name: "Test", input: { path: join(f.workspace, "y") } }, { agent: "main" }))
      .resolves.toMatchObject({ ok: true });
    expect(approvals).toBe(2);
  });

  describe("hint()", () => {
    it("returns the tool's summarize output when provided", () => {
      const f = fixture();
      const tool: ToolDefinition<{ path: string }> = {
        ...f.tool,
        summarize: (input) => `path=${input.path}`,
      };
      const runtime = new ToolRuntime({ tools: [tool], hooks: f.hooks, permissions: f.permissions });
      expect(runtime.hint({ name: "Test", input: { path: join(f.workspace, "x") } })).toBe(`path=${join(f.workspace, "x")}`);
    });

    it("returns undefined when the tool has no summarize", () => {
      const f = fixture();
      const runtime = new ToolRuntime({ tools: [f.tool], hooks: f.hooks, permissions: f.permissions });
      expect(runtime.hint({ name: "Test", input: { path: join(f.workspace, "x") } })).toBeUndefined();
    });

    it("returns undefined when summarize throws", () => {
      const f = fixture();
      const tool: ToolDefinition<{ path: string }> = {
        ...f.tool,
        summarize: () => { throw new Error("boom"); },
      };
      const runtime = new ToolRuntime({ tools: [tool], hooks: f.hooks, permissions: f.permissions });
      expect(runtime.hint({ name: "Test", input: { path: join(f.workspace, "x") } })).toBeUndefined();
    });

    it("returns undefined when the input fails the tool's inputSchema", () => {
      const f = fixture();
      const tool: ToolDefinition<{ path: string }> = {
        ...f.tool,
        summarize: (input) => `path=${input.path}`,
      };
      const runtime = new ToolRuntime({ tools: [tool], hooks: f.hooks, permissions: f.permissions });
      expect(runtime.hint({ name: "Test", input: { notPath: 42 } })).toBeUndefined();
    });

    it("returns undefined when summarize returns an empty string", () => {
      const f = fixture();
      const tool: ToolDefinition<{ path: string }> = {
        ...f.tool,
        summarize: () => "",
      };
      const runtime = new ToolRuntime({ tools: [tool], hooks: f.hooks, permissions: f.permissions });
      expect(runtime.hint({ name: "Test", input: { path: join(f.workspace, "x") } })).toBeUndefined();
    });

    it("returns undefined for an unknown tool name", () => {
      const f = fixture();
      const runtime = new ToolRuntime({ tools: [f.tool], hooks: f.hooks, permissions: f.permissions });
      expect(runtime.hint({ name: "NotRegistered", input: { path: "x" } })).toBeUndefined();
    });
  });
});
