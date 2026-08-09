import { describe, expect, it, vi } from "vitest";

import { DesktopRuntimeController, type RuntimeLike } from "../../src/desktop/runtime-controller.js";
import type { SessionOutput } from "../../src/ui/session.js";

function fakeRuntime(output: (event: SessionOutput) => void, sessionId = "session-live"): RuntimeLike {
  let mainModel = "openai:gpt-5";
  let permissionProfile: "standard" | "d2c" = "standard";
  return {
    sessionId,
    restoredTranscript: {
      completed: [{ id: 1, prompt: "earlier", assistantText: "answer", statusLines: [], blocks: [{ kind: "text", text: "answer" }] }],
      nextId: 2,
    },
    diagnostics: [],
    session: {
      active: false,
      start: vi.fn(async () => undefined),
      submit: vi.fn(async (prompt: string) => {
        output({ type: "text", text: `answer:${prompt}` });
        output({ type: "done", usage: { inputTokens: 2, outputTokens: 3 } });
      }),
      steer: vi.fn(),
      followUp: vi.fn(),
      queueSnapshot: vi.fn(() => ({ steering: [], followUp: [] })),
      interrupt: vi.fn(() => "cancelled" as const),
      close: vi.fn(async () => undefined),
    },
    services: {
      mainModel: () => mainModel,
      subagentModel: () => "openai:gpt-5-mini",
      permissionMode: () => "default" as const,
      setModel: vi.fn((role: "main" | "subagent", modelId: string) => { if (role === "main") mainModel = modelId; }),
      finishTask: vi.fn(async () => "Task completed; review 1 memory candidate."),
      refreshMemory: vi.fn(async () => undefined),
      questions: { pending: undefined, answer: vi.fn() },
    },
    approvals: { pending: undefined, resolve: vi.fn() },
    authorization: {
      permissionProfile: () => permissionProfile,
      setPermissionProfile: vi.fn((profile: "standard" | "d2c") => { permissionProfile = profile; }),
    },
    memoryReviews: { pending: [], autoDismissSeconds: 0, accept: vi.fn(async () => true), dismiss: vi.fn(() => true) },
    dispose: vi.fn(async () => undefined),
  };
}

describe("DesktopRuntimeController", () => {
  it("scopes the D2C permission profile to one complete Electron submission", async () => {
    let release!: () => void;
    const runtime = fakeRuntime(() => undefined);
    runtime.session.submit = vi.fn(async () => new Promise<void>((resolve) => { release = resolve; }));
    const controller = new DesktopRuntimeController({
      home: "C:\\Users\\demo", createRuntime: async () => runtime, listSessions: async () => [], emit: () => undefined,
    });
    await controller.openWorkspace("C:\\work");
    await controller.startSession();

    const running = controller.submit("generate the page", "prompt", [], "d2c");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(runtime.authorization.permissionProfile()).toBe("d2c");
    expect(runtime.authorization.setPermissionProfile).toHaveBeenCalledWith("d2c");
    release();
    await running;

    expect(runtime.authorization.permissionProfile()).toBe("standard");
    expect(runtime.authorization.setPermissionProfile).toHaveBeenLastCalledWith("standard");
  });

  it("restores the standard profile when a D2C submission fails", async () => {
    const runtime = fakeRuntime(() => undefined);
    runtime.session.submit = vi.fn(async () => { throw new Error("generation failed"); });
    const controller = new DesktopRuntimeController({
      home: "C:\\Users\\demo", createRuntime: async () => runtime, listSessions: async () => [], emit: () => undefined,
    });
    await controller.openWorkspace("C:\\work");
    await controller.startSession();

    await expect(controller.submit("generate the page", "prompt", [], "d2c")).rejects.toThrow("generation failed");
    expect(runtime.authorization.permissionProfile()).toBe("standard");
    expect(runtime.authorization.setPermissionProfile).toHaveBeenLastCalledWith("standard");
  });

  it("stores desktop attachments and submits a multimodal prompt to the active session", async () => {
    const runtime = fakeRuntime(() => undefined);
    const storeAttachments = vi.fn(async () => [{
      type: "image" as const,
      source: { type: "file" as const, path: "C:\\work\\.flavor\\session-assets\\session-live\\a.png" },
      mediaType: "image/png" as const,
      sha256: "a".repeat(64),
      bytes: 8,
      name: "screen.png",
    }]);
    const controller = new DesktopRuntimeController({
      home: "C:\\Users\\demo",
      createRuntime: async () => runtime,
      listSessions: async () => [],
      storeAttachments,
      emit: () => undefined,
    });
    await controller.openWorkspace("C:\\work");
    await controller.startSession();

    await controller.submit("", "prompt", [{
      name: "screen.png",
      mediaType: "image/png",
      dataBase64: "iVBORw0KGgo=",
    }]);

    expect(storeAttachments).toHaveBeenCalledWith("C:\\work", "session-live", [
      expect.objectContaining({ name: "screen.png" }),
    ]);
    expect(runtime.session.submit).toHaveBeenCalledWith({
      text: "",
      content: [expect.objectContaining({ type: "image", mediaType: "image/png" })],
    });
  });

  it("delegates MCP configuration CRUD to the opened project manager", async () => {
    const local = {
      name: "local", transport: "stdio" as const, enabled: true,
      config: { command: "node", args: [], env: {}, disabled: false, timeoutMs: 60_000 },
    };
    const mcp = {
      path: "C:\\work\\.flavor\\flavor.json",
      list: vi.fn(async () => [local]),
      create: vi.fn(async () => local),
      update: vi.fn(async () => local),
      setEnabled: vi.fn(async () => ({ ...local, enabled: false })),
      delete: vi.fn(async () => undefined),
    };
    const loadMcpManager = vi.fn(() => mcp);
    const controller = new DesktopRuntimeController({
      home: "C:\\Users\\demo", listSessions: async () => [], loadMcpManager, emit: () => undefined,
    });

    await expect(controller.listMcpServers()).rejects.toThrow(/open a project/i);
    await controller.openWorkspace("C:\\work");
    expect(await controller.listMcpServers()).toEqual([local]);
    await controller.saveMcpServer(undefined, { name: "local", config: { command: "node" } });
    await controller.saveMcpServer("local", { name: "renamed", config: { command: "bun" } });
    await controller.setMcpServerEnabled("renamed", false);
    await controller.deleteMcpServer("renamed");

    expect(loadMcpManager).toHaveBeenCalledWith("C:\\work");
    expect(mcp.create).toHaveBeenCalledWith("local", { command: "node" });
    expect(mcp.update).toHaveBeenCalledWith("local", "renamed", { command: "bun" });
    expect(mcp.setEnabled).toHaveBeenCalledWith("renamed", false);
    expect(mcp.delete).toHaveBeenCalledWith("renamed");
  });

  it("manages long-term memory through the opened workspace", async () => {
    const existing = { id: "aaaaaaaaaaaa", type: "project" as const, content: "Use npm." };
    const updated = { id: "bbbbbbbbbbbb", type: "project" as const, content: "Use pnpm." };
    const memory = {
      snapshot: vi.fn(async () => ({ enabled: true, path: "C:\\work\\.flavor\\memory\\MEMORY.md", entries: [existing] })),
      remember: vi.fn(async () => existing),
      update: vi.fn(async () => updated),
      delete: vi.fn(async () => true),
    };
    const loadMemoryManager = vi.fn(async () => memory);
    const runtime = fakeRuntime(() => undefined);
    const controller = new DesktopRuntimeController({
      home: "C:\\Users\\demo", listSessions: async () => [], loadMemoryManager,
      createRuntime: async () => runtime, emit: () => undefined,
    });

    await controller.openWorkspace("C:\\work");
    await controller.startSession();
    expect(await controller.listMemory()).toEqual(expect.objectContaining({ entries: [existing] }));
    expect(await controller.createMemory({ type: "project", content: "Use npm." })).toEqual(existing);
    expect(await controller.updateMemory(existing.id, { type: "project", content: "Use pnpm." })).toEqual(updated);
    expect(await controller.deleteMemory(updated.id)).toBe(true);
    expect(loadMemoryManager).toHaveBeenCalledWith("C:\\work", "C:\\Users\\demo");
    expect(runtime.services.refreshMemory).toHaveBeenCalledTimes(3);
  });

  it("opens a workspace, lists its sessions and starts a resumable runtime", async () => {
    const events: unknown[] = [];
    let output!: (event: SessionOutput) => void;
    const runtime = fakeRuntime((event) => output(event));
    const createRuntime = vi.fn(async (options: { output(event: SessionOutput): void }) => {
      output = options.output;
      return runtime;
    });
    const controller = new DesktopRuntimeController({
      home: "C:\\Users\\demo",
      createRuntime,
      listSessions: vi.fn(async () => [{ sessionId: "session-old", createdAt: "2026-07-18T00:00:00Z", updatedAt: "2026-07-19T00:00:00Z", mainModel: "openai:gpt-5" }]),
      emit: (event) => events.push(event),
    });

    const opened = await controller.openWorkspace("C:\\work\\demo");
    const started = await controller.startSession("session-old");
    await controller.submit("hello");

    expect(opened.workspace).toBe("C:\\work\\demo");
    expect(opened.sessions).toHaveLength(1);
    expect(createRuntime).toHaveBeenCalledWith(expect.objectContaining({ workspace: "C:\\work\\demo", resumeSession: "session-old" }));
    expect(started.restoredTranscript.completed).toEqual([expect.objectContaining({ prompt: "earlier" })]);
    expect(events).toContainEqual({
      type: "session-output",
      sessionId: "session-live",
      event: { type: "text", text: "answer:hello" },
    });
    expect(runtime.authorization.setPermissionProfile).not.toHaveBeenCalled();
  });

  it("publishes a new session to the sidebar before its first submission finishes", async () => {
    let release!: () => void;
    const runtime = fakeRuntime(() => undefined);
    runtime.session.submit = vi.fn(async () => new Promise<void>((resolve) => { release = resolve; }));
    const controller = new DesktopRuntimeController({
      home: "C:\\Users\\demo", createRuntime: async () => runtime, listSessions: async () => [], emit: () => undefined,
    });
    await controller.openWorkspace("C:\\work");

    const started = await controller.startSession();
    expect(started.snapshot.sessions).toEqual([
      expect.objectContaining({ sessionId: "session-live", mainModel: "openai:gpt-5" }),
    ]);

    const submission = controller.submit("执行 D2C 任务 test");
    expect(controller.snapshot().sessions).toEqual([
      expect.objectContaining({ sessionId: "session-live", preview: "执行 D2C 任务 test" }),
    ]);
    expect(controller.snapshot().activeSession?.busy).toBe(true);

    release();
    await submission;
    expect(controller.snapshot().sessions).toEqual([
      expect.objectContaining({ sessionId: "session-live", preview: "执行 D2C 任务 test" }),
    ]);
  });

  it("disposes the current runtime when switching projects", async () => {
    const first = fakeRuntime(() => undefined);
    const createRuntime = vi.fn(async () => first);
    const controller = new DesktopRuntimeController({
      home: "C:\\Users\\demo", createRuntime, listSessions: async () => [], emit: () => undefined,
    });
    await controller.openWorkspace("C:\\one");
    await controller.startSession();
    await controller.openWorkspace("C:\\two");
    expect(first.session.close).toHaveBeenCalledOnce();
    expect(first.dispose).toHaveBeenCalledOnce();
  });

  it("does not let a previous submission clear the busy state of a newly selected session", async () => {
    const releases: Array<() => void> = [];
    let runtimeNumber = 0;
    const createRuntime = vi.fn(async ({ output }: { output: (event: SessionOutput) => void }) => {
      const runtime = fakeRuntime(output, `session-${++runtimeNumber}`);
      runtime.session.submit = vi.fn(async () => new Promise<void>((resolve) => releases.push(resolve)));
      return runtime;
    });
    const controller = new DesktopRuntimeController({
      home: "C:\\Users\\demo", createRuntime, listSessions: async () => [], emit: () => undefined,
    });
    await controller.openWorkspace("C:\\work");
    await controller.startSession();
    const oldSubmission = controller.submit("old");

    await controller.startSession();
    const newSubmission = controller.submit("new");
    releases[0]!();
    await oldSubmission;

    expect(controller.snapshot().activeSession).toMatchObject({
      sessionId: "session-2",
      busy: true,
    });

    releases[1]!();
    await newSubmission;
  });

  it("delivers steering and follow-up messages while a task is running", async () => {
    let release!: () => void;
    const runtime = fakeRuntime(() => undefined);
    runtime.session.submit = vi.fn(async () => new Promise<void>((resolve) => { release = resolve; }));
    runtime.session.queueSnapshot = vi.fn(() => ({
      steering: ["change direction"],
      followUp: ["then write docs"],
    }));
    const controller = new DesktopRuntimeController({
      home: "C:\\Users\\demo", createRuntime: async () => runtime, listSessions: async () => [], emit: () => undefined,
    });
    await controller.openWorkspace("C:\\work");
    await controller.startSession();

    const running = controller.submit("start");
    await new Promise((resolve) => setTimeout(resolve, 0));
    await controller.submit("change direction", "steer");
    await controller.submit("then write docs", "followUp");

    expect(runtime.session.steer).toHaveBeenCalledWith("change direction");
    expect(runtime.session.followUp).toHaveBeenCalledWith("then write docs");
    expect(controller.snapshot().activeSession?.queue).toEqual({
      steering: ["change direction"],
      followUp: ["then write docs"],
    });
    release();
    await running;
  });

  it("forwards permission, question, and memory-review answers only to an active runtime", async () => {
    const runtime = fakeRuntime(() => undefined);
    const controller = new DesktopRuntimeController({
      home: "C:\\Users\\demo", createRuntime: async () => runtime, listSessions: async () => [], emit: () => undefined,
    });
    await controller.openWorkspace("C:\\work");
    await controller.startSession();
    controller.resolveApproval("deny");
    controller.resolveApproval("allow");
    controller.answerQuestions({ 0: "Continue" });
    await controller.resolveMemoryReview("memory-review-1", "accept");
    await controller.resolveMemoryReview("memory-review-2", "dismiss");
    expect(runtime.approvals.resolve).toHaveBeenCalledWith("deny");
    expect(runtime.approvals.resolve).toHaveBeenCalledWith("once");
    expect(runtime.services.questions.answer).toHaveBeenCalledWith({ 0: "Continue" });
    expect(runtime.memoryReviews.accept).toHaveBeenCalledWith("memory-review-1");
    expect(runtime.memoryReviews.dismiss).toHaveBeenCalledWith("memory-review-2");
  });

  it("finishes the active task and publishes the result as a non-blocking notice", async () => {
    const events: unknown[] = [];
    const runtime = fakeRuntime(() => undefined);
    const controller = new DesktopRuntimeController({
      home: "C:\\Users\\demo", createRuntime: async () => runtime, listSessions: async () => [],
      emit: (event) => events.push(event),
    });
    await controller.openWorkspace("C:\\work");
    await controller.startSession();

    await expect(controller.finishTask()).resolves.toBe("Task completed; review 1 memory candidate.");

    expect(runtime.services.finishTask).toHaveBeenCalledOnce();
    expect(events).toContainEqual({
      type: "session-output",
      sessionId: "session-live",
      event: { type: "notice", message: "Task completed; review 1 memory candidate." },
    });
  });

  it("disposes an active session before deleting it and publishes the remaining history", async () => {
    const runtime = fakeRuntime(() => undefined);
    let sessions = [{ sessionId: "session-live", createdAt: "2026-07-19T00:00:00Z", updatedAt: "2026-07-19T00:00:00Z", mainModel: "openai:gpt-5" }];
    const deleteSession = vi.fn(async () => { sessions = []; });
    const controller = new DesktopRuntimeController({
      home: "C:\\Users\\demo",
      createRuntime: async () => runtime,
      listSessions: async () => sessions,
      deleteSession,
      emit: () => undefined,
    });
    await controller.openWorkspace("C:\\work");
    await controller.startSession("session-live");

    const snapshot = await controller.deleteSession("session-live");

    expect(runtime.session.close).toHaveBeenCalledOnce();
    expect(runtime.dispose).toHaveBeenCalledOnce();
    expect(deleteSession).toHaveBeenCalledWith("C:\\work", "session-live");
    expect(snapshot.activeSession).toBeUndefined();
    expect(snapshot.sessions).toEqual([]);
  });

  it("persists a custom provider, reloads the runtime and switches to its model", async () => {
    const first = fakeRuntime(() => undefined);
    const second = fakeRuntime(() => undefined);
    const createRuntime = vi.fn()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second);
    const custom = {
      id: "siliconflow:qwen3-coder", provider: "siliconflow", model: "qwen3-coder",
      label: "qwen3-coder", description: "siliconflow · OpenAI 兼容 API", source: "custom" as const,
    };
    const saveModel = vi.fn(async () => custom);
    const loadModels = vi.fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([custom]);
    const controller = new DesktopRuntimeController({
      home: "C:\\Users\\demo", createRuntime, listSessions: async () => [], saveModel, loadModels, emit: () => undefined,
    });
    await controller.openWorkspace("C:\\work");
    await controller.startSession();

    const result = await controller.addModel({
      provider: "siliconflow", model: "qwen3-coder", baseURL: "https://api.siliconflow.cn/v1",
      apiKey: "secret", protocol: "openai-compatible",
    });

    expect(saveModel).toHaveBeenCalledOnce();
    expect(first.session.close).toHaveBeenCalledOnce();
    expect(second.services.setModel).toHaveBeenCalledWith("main", custom.id);
    expect(result.snapshot.activeSession?.mainModel).toBe(custom.id);
    expect(result.snapshot.models).toContainEqual(custom);
  });
});
