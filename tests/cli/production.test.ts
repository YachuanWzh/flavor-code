import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

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
      conversation: { messages: [] },
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
