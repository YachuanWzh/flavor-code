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
      questions: { pending: undefined, answer: vi.fn() },
    },
    approvals: { pending: undefined, resolve: vi.fn() },
    dispose: vi.fn(async () => undefined),
  };
}

describe("DesktopRuntimeController", () => {
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

  it("forwards permission and question answers only to an active runtime", async () => {
    const runtime = fakeRuntime(() => undefined);
    const controller = new DesktopRuntimeController({
      home: "C:\\Users\\demo", createRuntime: async () => runtime, listSessions: async () => [], emit: () => undefined,
    });
    await controller.openWorkspace("C:\\work");
    await controller.startSession();
    controller.resolveApproval("deny");
    controller.resolveApproval("allow");
    controller.answerQuestions({ 0: "Continue" });
    expect(runtime.approvals.resolve).toHaveBeenCalledWith("deny");
    expect(runtime.approvals.resolve).toHaveBeenCalledWith("once");
    expect(runtime.services.questions.answer).toHaveBeenCalledWith({ 0: "Continue" });
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
