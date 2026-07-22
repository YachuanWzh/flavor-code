import { describe, expect, it, vi } from "vitest";

import { DesktopRuntimeController, type RuntimeLike } from "../../src/desktop/runtime-controller.js";
import type { SessionOutput } from "../../src/ui/session.js";

function fakeRuntime(output: (event: SessionOutput) => void): RuntimeLike {
  let mainModel = "openai:gpt-5";
  return {
    sessionId: "session-live",
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
      interrupt: vi.fn(() => "cancelled" as const),
      close: vi.fn(async () => undefined),
    },
    services: {
      mainModel: () => mainModel,
      subagentModel: () => "openai:gpt-5-mini",
      permissionMode: () => "default" as const,
      setModel: vi.fn((role: "main" | "subagent", modelId: string) => { if (role === "main") mainModel = modelId; }),
      finishTask: vi.fn(async () => "Task completed; review 1 memory candidate."),
      questions: { pending: undefined, answer: vi.fn() },
    },
    approvals: { pending: undefined, resolve: vi.fn() },
    memoryReviews: { pending: [], accept: vi.fn(async () => true), dismiss: vi.fn(() => true) },
    dispose: vi.fn(async () => undefined),
  };
}

describe("DesktopRuntimeController", () => {
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
    const controller = new DesktopRuntimeController({
      home: "C:\\Users\\demo", listSessions: async () => [], loadMemoryManager, emit: () => undefined,
    });

    await controller.openWorkspace("C:\\work");
    expect(await controller.listMemory()).toEqual(expect.objectContaining({ entries: [existing] }));
    expect(await controller.createMemory({ type: "project", content: "Use npm." })).toEqual(existing);
    expect(await controller.updateMemory(existing.id, { type: "project", content: "Use pnpm." })).toEqual(updated);
    expect(await controller.deleteMemory(updated.id)).toBe(true);
    expect(loadMemoryManager).toHaveBeenCalledWith("C:\\work", "C:\\Users\\demo");
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
    expect(events).toContainEqual({ type: "session-output", event: { type: "text", text: "answer:hello" } });
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
