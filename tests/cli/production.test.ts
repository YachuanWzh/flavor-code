import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createProductionRuntime, createPromptEnvironment } from "../../src/production.js";
import { SessionStore } from "../../src/session/store.js";
import { writeFile, mkdir } from "node:fs/promises";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("production runtime", () => {
  it("creates deterministic prompt environment data with explicit fallbacks", () => {
    expect(createPromptEnvironment({
      now: new Date("2026-07-13T23:59:00.000Z"),
      platform: "win32",
      osVersion: "Windows 11 10.0.26100",
      shell: "powershell.exe",
      isGitRepository: true,
    })).toEqual({
      date: "2026-07-13",
      platform: "win32",
      osVersion: "Windows 11 10.0.26100",
      shell: "powershell.exe",
      isGitRepository: true,
    });
    expect(createPromptEnvironment({
      now: new Date("invalid"), platform: " ", osVersion: "", shell: "\n", isGitRepository: "unknown",
    })).toEqual({
      date: "unknown", platform: "unknown", osVersion: "unknown", shell: "unknown", isGitRepository: "unknown",
    });
  });

  it("does not advertise AskUserQuestion in non-interactive mode", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "flavor-production-")); roots.push(workspace);
    const pluginRoot = join(workspace, ".flavor", "plugins", "capture-model");
    await mkdir(pluginRoot, { recursive: true });
    await writeFile(join(workspace, ".flavor", "flavor.json"), JSON.stringify({
      providers: { capture: { type: "plugin", defaultModel: "main", cheapModel: "child" } },
      agents: { main: { model: "capture:main" }, subagent: { model: "capture:child" } },
    }));
    await writeFile(join(pluginRoot, "flavor-plugin.json"), JSON.stringify({
      name: "capture-model", version: "1.0.0", apiVersion: "1", main: "index.mjs", permissions: [],
      contributes: { commands: [], tools: [], hooks: [], skillRoots: [], modelAdapters: [{ name: "capture" }] },
    }));
    await writeFile(join(pluginRoot, "index.mjs"), `export function activate(ctx) {
      ctx.registerModelAdapter("capture", { async *stream(request) {
        globalThis.__flavorPromptRequests ??= [];
        globalThis.__flavorPromptRequests.push({
          tools: request.tools.map((tool) => tool.name),
          system: request.messages.filter((message) => message.role === "system").map((message) => message.content).join("\\n\\n"),
        });
        yield { type: "done", usage: { inputTokens: 0, outputTokens: 0 } };
      }});
    }`);
    const globalState = globalThis as typeof globalThis & { __flavorPromptRequests?: Array<{ tools: string[]; system: string }> };
    delete globalState.__flavorPromptRequests;
    const runtime = await createProductionRuntime({
      workspace, home: workspace, environment: {}, approvalPolicy: "deny", output: () => {},
    });

    await runtime.session.start();
    await runtime.session.submit("inspect the project");

    const requests = (globalThis as { __flavorPromptRequests?: Array<{ tools: string[]; system: string }> })
      .__flavorPromptRequests;
    expect(requests).toHaveLength(1);
    expect(requests?.[0]?.tools).not.toContain("AskUserQuestion");
    expect(requests?.[0]?.system).not.toContain("`AskUserQuestion`");
    await runtime.dispose();
    delete globalState.__flavorPromptRequests;
  });

  it("runs /loop through a fresh worker and host verifier", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "flavor-production-loop-")); roots.push(workspace);
    const pluginRoot = join(workspace, ".flavor", "plugins", "loop-model");
    await mkdir(pluginRoot, { recursive: true });
    await writeFile(join(workspace, "package.json"), JSON.stringify({
      name: "loop-fixture", private: true,
      scripts: { test: "node -e \"require('node:fs').accessSync('package.json')\"" },
    }));
    await writeFile(join(workspace, ".flavor", "flavor.json"), JSON.stringify({
      providers: { capture: { type: "plugin", defaultModel: "main", cheapModel: "child" } },
      agents: { main: { model: "capture:main" }, subagent: { model: "capture:child" } },
      loop: { maxCycles: 3, maxTokens: 1000, isolation: "auto" },
    }));
    await writeFile(join(pluginRoot, "flavor-plugin.json"), JSON.stringify({
      name: "loop-model", version: "1.0.0", apiVersion: "1", main: "index.mjs", permissions: [],
      contributes: { commands: [], tools: [], hooks: [], skillRoots: [], modelAdapters: [{ name: "capture" }] },
    }));
    await writeFile(join(pluginRoot, "index.mjs"), `export function activate(ctx) {
      ctx.registerModelAdapter("capture", { async *stream(request) {
        globalThis.__flavorLoopRequests ??= [];
        globalThis.__flavorLoopRequests.push(request.messages);
        yield { type: "text", text: "Ready for host verification." };
        yield { type: "usage", inputTokens: 10, outputTokens: 5 };
        yield { type: "done", usage: { inputTokens: 10, outputTokens: 5 } };
      }});
    }`);
    const globalState = globalThis as typeof globalThis & { __flavorLoopRequests?: unknown[][] };
    delete globalState.__flavorLoopRequests;
    const outputs: Array<{ type?: string; phase?: string; state?: string; message?: string }> = [];
    const runtime = await createProductionRuntime({
      workspace, home: workspace, environment: {}, approvalPolicy: "deny",
      output: (event) => outputs.push(event as typeof outputs[number]),
    });

    await runtime.session.start();
    await runtime.session.submit("/loop analyze the current project");

    expect(globalState.__flavorLoopRequests).toHaveLength(1);
    expect(JSON.stringify(globalState.__flavorLoopRequests)).toContain("Built-in Loop Skill");
    expect(outputs).toContainEqual(expect.objectContaining({
      type: "loop-progress", phase: "terminal", state: "completed",
    }));
    expect(outputs.find((event) => event.type === "loop-progress" && event.phase === "terminal")?.message)
      .toContain("succeeded");
    await runtime.dispose();
    delete globalState.__flavorLoopRequests;
  });

  it("asks again at each loop budget tranche", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "flavor-production-budget-")); roots.push(workspace);
    const pluginRoot = join(workspace, ".flavor", "plugins", "budget-model");
    await mkdir(pluginRoot, { recursive: true });
    await writeFile(join(workspace, "package.json"), JSON.stringify({
      name: "budget-fixture", private: true, scripts: { test: "node -e \"process.exit(1)\"" },
    }));
    await writeFile(join(workspace, ".flavor", "flavor.json"), JSON.stringify({
      providers: { capture: { type: "plugin", defaultModel: "main", cheapModel: "child" } },
      agents: { main: { model: "capture:main" }, subagent: { model: "capture:child" } },
      loop: { maxCycles: 1, maxTokens: 1000, isolation: "auto" },
    }));
    await writeFile(join(pluginRoot, "flavor-plugin.json"), JSON.stringify({
      name: "budget-model", version: "1.0.0", apiVersion: "1", main: "index.mjs", permissions: [],
      contributes: { commands: [], tools: [], hooks: [], skillRoots: [], modelAdapters: [{ name: "capture" }] },
    }));
    await writeFile(join(pluginRoot, "index.mjs"), `export function activate(ctx) {
      ctx.registerModelAdapter("capture", { async *stream() {
        yield { type: "done", usage: { inputTokens: 1, outputTokens: 1 } };
      }});
    }`);
    const outputs: Array<{ type?: string; phase?: string; message?: string }> = [];
    const runtime = await createProductionRuntime({
      workspace, home: workspace, environment: {},
      output: (event) => outputs.push(event as typeof outputs[number]),
    });

    const submission = runtime.session.submit("/loop analyze the current project");
    await vi.waitFor(() => expect(runtime.services.questions.pending?.[0]?.question).toContain("1 cycles"));
    expect(runtime.services.questions.pending?.[0]?.question).toContain("2 cycles");
    expect(runtime.services.questions.pending?.[0]?.question).toContain("test failed with exit code 1");
    runtime.services.questions.answer({ 0: "Continue" });
    await vi.waitFor(() => expect(runtime.services.questions.pending?.[0]?.question).toContain("2 cycles"));
    expect(runtime.services.questions.pending?.[0]?.question).toContain("3 cycles");
    runtime.services.questions.answer({ 0: "Stop" });
    await submission;

    expect(outputs.find((event) => event.phase === "terminal")?.message).toContain("budget_exhausted");
    await runtime.dispose();
  });

  it("uses a worker discovery cycle instead of exiting at zero tokens without a verifier", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "flavor-production-discovery-")); roots.push(workspace);
    const pluginRoot = join(workspace, ".flavor", "plugins", "discovery-model");
    await mkdir(pluginRoot, { recursive: true });
    await writeFile(join(workspace, ".flavor", "flavor.json"), JSON.stringify({
      providers: { capture: { type: "plugin", defaultModel: "main", cheapModel: "child" } },
      agents: { main: { model: "capture:main" }, subagent: { model: "capture:child" } },
    }));
    await writeFile(join(pluginRoot, "flavor-plugin.json"), JSON.stringify({
      name: "discovery-model", version: "1.0.0", apiVersion: "1", main: "index.mjs", permissions: [],
      contributes: { commands: [], tools: [], hooks: [], skillRoots: [], modelAdapters: [{ name: "capture" }] },
    }));
    await writeFile(join(pluginRoot, "index.mjs"), `export function activate(ctx) {
      ctx.registerModelAdapter("capture", { async *stream() {
        globalThis.__flavorDiscoveryCalls = (globalThis.__flavorDiscoveryCalls ?? 0) + 1;
        yield { type: "done", usage: { inputTokens: 7, outputTokens: 3 } };
      }});
    }`);
    const globalState = globalThis as typeof globalThis & { __flavorDiscoveryCalls?: number };
    delete globalState.__flavorDiscoveryCalls;
    const outputs: Array<{ type?: string; phase?: string; message?: string; usage?: { inputTokens: number; outputTokens: number } }> = [];
    const runtime = await createProductionRuntime({
      workspace, home: workspace, environment: {}, approvalPolicy: "deny",
      output: (event) => outputs.push(event as typeof outputs[number]),
    });

    await runtime.session.submit("/loop analyze and improve direction four");

    expect(globalState.__flavorDiscoveryCalls).toBe(1);
    expect(outputs.find((event) => event.phase === "resolved")?.message).toContain("discovery");
    expect(outputs.find((event) => event.phase === "terminal")?.message).toContain("needs_human");
    expect(outputs.find((event) => event.type === "done")?.usage).toEqual({ inputTokens: 7, outputTokens: 3 });
    await runtime.dispose();
    delete globalState.__flavorDiscoveryCalls;
  });

  it("restores a main plan and publishes its task snapshot at session start", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "flavor-production-")); roots.push(workspace);
    await mkdir(join(workspace, ".flavor"), { recursive: true });
    await writeFile(join(workspace, ".flavor", "flavor.json"), JSON.stringify({
      providers: { local: { type: "openai-compatible", baseURL: "http://127.0.0.1:1/v1", defaultModel: "large", cheapModel: "small" } },
    }));
    const store = new SessionStore({ workspace });
    await store.save({
      version: 2,
      sessionId: "planned-session",
      createdAt: "2026-07-13T01:00:00.000Z",
      updatedAt: "2026-07-13T01:01:00.000Z",
      workspace: { path: workspace },
      conversation: { messages: [
        { role: "user", content: "persist me" },
        { role: "assistant", content: "persisted answer" },
        { role: "tool", content: "hidden tool output", toolCallId: "call-1" },
      ] },
      tasks: {
        plan: { tasks: [{
          id: "inspect", subject: "Inspect code", activeForm: "Inspecting code",
          status: "pending", dependencies: [],
        }] },
        states: {},
        results: {},
      },
      models: { main: "local:large", subagent: "local:small" },
      permissionMode: "workspace",
    });
    const outputs: unknown[] = [];
    const runtime = await createProductionRuntime({
      workspace, home: workspace, environment: {}, resumeSession: "planned-session",
      output: (event) => outputs.push(event),
    });

    await runtime.session.start();

    expect(runtime.restoredMessages).toEqual([
      { role: "user", content: "persist me" },
      { role: "assistant", content: "persisted answer" },
      { role: "tool", content: "hidden tool output" },
    ]);
    expect(runtime.services.tasks()).toMatchObject({ plan: { tasks: [{ id: "inspect" }] } });
    expect(outputs).toContainEqual(expect.objectContaining({
      type: "tasks",
      snapshot: expect.objectContaining({ plan: { tasks: [expect.objectContaining({ id: "inspect" })] } }),
    }));
    await runtime.dispose();
  });

  it("saves lifecycle state and resumes only when explicitly requested", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "flavor-production-")); roots.push(workspace);
    await mkdir(join(workspace, ".flavor"), { recursive: true });
    await writeFile(join(workspace, ".flavor", "flavor.json"), JSON.stringify({
      providers: { local: { type: "openai-compatible", baseURL: "http://127.0.0.1:1/v1", defaultModel: "large", cheapModel: "small" } },
    }));
    const first = await createProductionRuntime({ workspace, home: workspace, environment: {}, output: () => {} });
    await first.session.start();
    first.services.setPermissionMode("safe");
    await first.session.submit("persist me");
    await first.session.close(); await first.dispose();
    const saved = await new SessionStore({ workspace }).load();
    expect(saved.conversation.messages.some((message) => message.role === "user" && message.content === "persist me")).toBe(true);
    expect(saved.permissionMode).toBe("safe");

    const fresh = await createProductionRuntime({ workspace, home: workspace, environment: {}, output: () => {} });
    expect(fresh.restoredMessages).toEqual([]);
    expect(fresh.services.permissionMode()).toBe("workspace");
    await fresh.dispose();
    const resumed = await createProductionRuntime({ workspace, home: workspace, environment: {}, resumeSession: saved.sessionId, output: () => {} });
    expect(resumed.services.permissionMode()).toBe("safe");
    expect(resumed.sessionId).toBe(saved.sessionId);
    await resumed.dispose();
  });
  it("starts without credentials and returns actionable model setup output", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "flavor-production-")); roots.push(workspace);
    const output: string[] = [];
    const runtime = await createProductionRuntime({
      workspace, home: workspace, environment: {},
      output: (event) => { if (event.type === "error") output.push(event.error.message); },
    });
    await runtime.session.start();
    await runtime.session.submit("hello");
    await runtime.session.close();
    await runtime.dispose();
    expect(output.join("\n")).toContain(".flavor/flavor.json");
  });

  it("approval bridge waits for and resolves a UI decision", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "flavor-production-")); roots.push(workspace);
    const runtime = await createProductionRuntime({ workspace, home: workspace, environment: {}, output: () => {} });
    const pending = runtime.approvals.request({ agent: "main", tool: "Write", paths: [workspace] });
    expect(runtime.approvals.pending?.tool).toBe("Write");
    runtime.approvals.resolve("once");
    await expect(pending).resolves.toBe("once");
    await runtime.dispose();
  });

  it("cancels and clears a pending approval when its run aborts", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "flavor-production-")); roots.push(workspace);
    const runtime = await createProductionRuntime({ workspace, home: workspace, environment: {}, output: () => {} });
    const controller = new AbortController();
    const pending = runtime.approvals.request({ agent: "main", tool: "Write", paths: [workspace] }, controller.signal);
    controller.abort(new Error("cancel approval"));
    await expect(pending).resolves.toBe("deny");
    expect(runtime.approvals.pending).toBeUndefined();
    await runtime.dispose();
  });

  it("selects deterministic main and cheaper models from a configured provider", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "flavor-production-")); roots.push(workspace);
    await mkdir(join(workspace, ".flavor"), { recursive: true });
    await writeFile(join(workspace, ".flavor", "flavor.json"), JSON.stringify({
      providers: { local: { type: "openai-compatible", baseURL: "http://localhost:1234/v1", defaultModel: "large", cheapModel: "small" } },
    }));
    const runtime = await createProductionRuntime({ workspace, home: workspace, environment: {}, output: () => {} });
    expect(runtime.services.mainModel()).toBe("local:large");
    expect(runtime.services.subagentModel()).toBe("local:small");
    expect(runtime.services.config()).toMatchObject({
      context: {
        windowTokens: 200_000,
        reservedOutputTokens: 20_000,
        autoCompactBufferTokens: 13_000,
      },
    });
    await runtime.dispose();
  });

  it("requires an explicit cheap model for custom child agents", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "flavor-production-")); roots.push(workspace);
    await mkdir(join(workspace, ".flavor"), { recursive: true });
    await writeFile(join(workspace, ".flavor", "flavor.json"), JSON.stringify({
      providers: { local: { type: "openai-compatible", baseURL: "http://localhost:1234/v1", defaultModel: "large" } },
    }));
    const runtime = await createProductionRuntime({ workspace, home: workspace, environment: {}, output: () => {} });
    expect(runtime.services.subagentModel()).toContain("configure-cheap-model");
    expect(JSON.stringify(runtime.services.config())).toContain("requires cheapModel");
    await runtime.dispose();
  });

  it("uses an official cheaper default and never silently reuses the main model", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "flavor-production-")); roots.push(workspace);
    const runtime = await createProductionRuntime({ workspace, home: workspace,
      environment: { OPENAI_API_KEY: "test-key" }, output: () => {} });
    expect(runtime.services.mainModel()).toBe("openai:gpt-5");
    expect(runtime.services.subagentModel()).toBe("openai:gpt-5-mini");
    await runtime.dispose();
  });

  it("audits all five recoverable failures while exposing only the final error", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "flavor-production-")); roots.push(workspace);
    const pluginRoot = join(workspace, ".flavor", "plugins", "failing-model");
    await mkdir(pluginRoot, { recursive: true });
    await writeFile(join(workspace, ".flavor", "flavor.json"), JSON.stringify({
      providers: { failing: { type: "plugin", defaultModel: "main", cheapModel: "cheap" } },
      agents: { main: { model: "failing:main" }, subagent: { model: "failing:cheap" } },
    }));
    await writeFile(join(pluginRoot, "flavor-plugin.json"), JSON.stringify({
      name: "failing-model", version: "1.0.0", apiVersion: "1", main: "index.mjs", permissions: [],
      contributes: { commands: [], tools: [], hooks: [], skillRoots: [], modelAdapters: [{ name: "failing" }] },
    }));
    await writeFile(join(pluginRoot, "index.mjs"), `export function activate(ctx) {
      ctx.registerModelAdapter("failing", { async *stream(request) {
        globalThis.__flavorRetryModels ??= [];
        globalThis.__flavorRetryModels.push(request.model);
        yield { type: "error", error: {
          code: "network", message: "terminated-" + globalThis.__flavorRetryModels.length,
        } };
      }});
    }`);
    const outputs: unknown[] = [];
    const runtime = await createProductionRuntime({
      workspace, home: workspace, environment: {}, output: (event) => outputs.push(event),
    });

    vi.useFakeTimers();
    try {
      const submission = runtime.session.submit("retry safely");
      await vi.runAllTimersAsync();
      await submission;
    } finally {
      vi.useRealTimers();
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect((globalThis as { __flavorRetryModels?: string[] }).__flavorRetryModels)
      .toEqual(["main", "main", "main", "cheap", "cheap"]);
    expect(outputs.filter((event): event is { type: "error"; error: { message: string } } =>
      typeof event === "object" && event !== null && (event as { type?: string }).type === "error"))
      .toEqual([{ type: "error", error: { code: "network", message: "terminated-5" } }]);
    expect(JSON.stringify(outputs.filter((event) =>
      typeof event === "object" && event !== null && (event as { type?: string }).type === "model-retry")))
      .not.toContain("terminated-");

    const auditEntries = (await readFile(join(workspace, ".flavor", "audit.jsonl"), "utf8"))
      .trim().split("\n").map((line) => JSON.parse(line));
    expect(auditEntries).toHaveLength(5);
    expect(auditEntries.map(({ attempt, maxAttempts }) => ({ attempt, maxAttempts }))).toEqual([
      { attempt: 1, maxAttempts: 5 }, { attempt: 2, maxAttempts: 5 },
      { attempt: 3, maxAttempts: 5 }, { attempt: 4, maxAttempts: 5 },
      { attempt: 5, maxAttempts: 5 },
    ]);

    await runtime.dispose();
    delete (globalThis as { __flavorRetryModels?: string[] }).__flavorRetryModels;
  });

  it("activates, dispatches, and unloads a validated plugin command", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "flavor-production-")); roots.push(workspace);
    const root = join(workspace, ".flavor", "plugins", "taste"); await mkdir(root, { recursive: true });
    await writeFile(join(root, "flavor-plugin.json"), JSON.stringify({
      name: "taste", version: "1.0.0", apiVersion: "1", main: "index.mjs", permissions: [],
      contributes: { commands: [{ name: "taste" }], tools: [], hooks: [], skillRoots: [], modelAdapters: [] },
    }));
    await writeFile(join(root, "index.mjs"), `export function activate(ctx) {
      ctx.registerCommand("taste", (args) => ({ joined: args.join("+") }));
      return () => { globalThis.tasteUnloaded = true; };
    }`);
    const output: string[] = [];
    const runtime = await createProductionRuntime({ workspace, home: workspace, environment: {},
      output: (event) => { if (event.type === "notice") output.push(event.message); } });
    await runtime.session.start(); await runtime.session.submit("/taste saffron plum");
    expect(output.join("\n")).toContain("saffron+plum");
    await runtime.dispose();
    expect((globalThis as Record<string, unknown>).tasteUnloaded).toBe(true);
    delete (globalThis as Record<string, unknown>).tasteUnloaded;
  });

  it("disposes the main harness idempotently", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "flavor-production-")); roots.push(workspace);
    const runtime = await createProductionRuntime({ workspace, home: workspace, environment: {}, output: () => {} });
    await runtime.dispose(); await runtime.dispose();
    await expect(runtime.services.run("late", new AbortController().signal)[Symbol.asyncIterator]().next())
      .resolves.toMatchObject({ value: { type: "error" } });
  });

  it("rolls back activated plugins when contributed tool schema breaks bootstrap", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "flavor-production-")); roots.push(workspace);
    const root = join(workspace, ".flavor", "plugins", "broken-tool"); await mkdir(root, { recursive: true });
    await writeFile(join(root, "flavor-plugin.json"), JSON.stringify({
      name: "broken-tool", version: "1.0.0", apiVersion: "1", main: "index.mjs", permissions: [],
      contributes: { commands: [], tools: [{ name: "Broken" }], hooks: [], skillRoots: [], modelAdapters: [] },
    }));
    await writeFile(join(root, "index.mjs"), `export function activate(ctx) {
      ctx.registerTool("Broken", { name: "Broken", description: "bad", inputSchema: {}, paths: () => [], execute: async () => null });
      return () => { globalThis.brokenToolDisposed = true; };
    }`);
    await expect(createProductionRuntime({ workspace, home: workspace, environment: {}, output: () => {} })).rejects.toThrow();
    expect((globalThis as Record<string, unknown>).brokenToolDisposed).toBe(true);
    delete (globalThis as Record<string, unknown>).brokenToolDisposed;
  });
});
