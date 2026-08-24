import { describe, expect, it, vi } from "vitest";

import { HookBus } from "../../src/hooks/bus.js";
import { QuestionBridge } from "../../src/tools/ask-user-question.js";
import { FlavorSession, type PalCoWorkDelivery, type SessionServices } from "../../src/ui/session.js";

function services(events: string[], outputs: string[]): SessionServices {
  const hooks = new HookBus();
  const questions = new QuestionBridge();
  for (const type of ["SessionStart", "UserPromptSubmit", "Stop", "SessionEnd"] as const) {
    hooks.on(type, (event) => { events.push(event.type); return { decision: "allow" }; });
  }
  return {
    hooks,
    workspace: "/work",
    mainModel: () => "openai:gpt-test",
    subagentModel: () => "openai:gpt-cheap",
    permissionMode: () => "default",
    run: async function* (_prompt, signal) {
      yield { type: "text", text: "hel" };
      if (signal.aborted) return;
      yield { type: "text", text: "lo" };
      yield { type: "done", usage: { inputTokens: 1, outputTokens: 1 } };
    },
    runSkill: async function* () {},
    runLoop: async function* () {},
    runGoal: async function* () {},
    mcp: async () => "No MCP servers configured.",
    ide: async () => "Connected to Visual Studio Code: src/main.ts:6:9.",
    setModel: () => {}, setPermissionMode: () => {}, compact: async () => false,
    initialize: async () => ({ path: "/work/FLAVOR.md", created: true }),
    config: () => ({ providers: { openai: { apiKey: "top-secret", token: "also-secret" } } }),
    skills: async () => [], plugins: () => [], hooksStatus: () => [], tasks: () => [], audit: async () => "", evolve: async () => "", usage: async () => "", cancelActiveTask: async () => {},
    clearContext: async () => {},
    memory: async () => "memory contents",
    remember: async () => "remembered",
    forget: async () => "forgotten",
    forgetCold: async () => "forgotten cold",
    finishTask: async () => "Task completed; no durable memory candidates.",
    pluginCommands: () => [], runPluginCommand: async () => undefined,
    output: (event) => outputs.push(event.type === "text" ? event.text : event.type === "notice" ? event.message : event.type),
    questions,
    login: async () => "authenticated",
    logout: async () => "logged out",
  };
}

describe("FlavorSession", () => {
  it("dispatches pal list, rename, info, task, and co-work commands through the narrow service", async () => {
    const events: string[] = []; const outputs: string[] = [];
    const base = services(events, outputs);
    const pals = {
      list: vi.fn(async () => [{ alias: "B", id: "peer-b" }]),
      rename: vi.fn(async () => ({ alias: "A2", id: "peer-a" })),
      info: vi.fn(async () => ({ alias: "B", id: "peer-b", projectPath: "/api" })),
      sendTask: vi.fn(async () => ({ status: "delivered", recipientIds: ["peer-b"] })),
      startCoWork: vi.fn(async () => ({ coWorkId: "work-1", phase: "proposed" })),
      coWorkStatus: vi.fn(async () => ({ coWorkId: "work-1", phase: "running" })),
      cancelCoWork: vi.fn(async () => ({ coWorkId: "work-1", phase: "failed" })),
    };
    base.pals = pals;
    base.run = async function* () { throw new Error("ordinary run must not be called"); };
    const session = new FlavorSession(base);

    await session.submit("/pals --verbose");
    await session.submit("/pals rename A2");
    await session.submit("/pals info B");
    await session.submit("/chat B 你好啊");
    await session.submit("/co-work B upgrade the API");
    await session.submit("/co-work status work-1");
    await session.submit("/co-work cancel work-1 obsolete plan");

    expect(pals.list).toHaveBeenCalledWith(true);
    expect(pals.rename).toHaveBeenCalledWith("A2");
    expect(pals.info).toHaveBeenCalledWith("B");
    expect(pals.sendTask).toHaveBeenCalledWith("B", "你好啊");
    expect(pals.startCoWork).toHaveBeenCalledWith("B", "upgrade the API");
    expect(pals.coWorkStatus).toHaveBeenCalledWith("work-1");
    expect(pals.cancelCoWork).toHaveBeenCalledWith("work-1", "obsolete plan");
    expect(outputs.join("\n")).toContain("delivered");
  });

  it("dispatches /logout through the logout service", async () => {
    const events: string[] = []; const outputs: string[] = [];
    const base = services(events, outputs);
    const logout = vi.fn(async () => "Logged out. Cleared OAuth credentials.");
    base.logout = logout;
    base.run = async function* () { throw new Error("ordinary run must not be called"); };
    const session = new FlavorSession(base);

    await session.submit("/logout");

    expect(logout).toHaveBeenCalledTimes(1);
    expect(outputs.join("\n")).toContain("Logged out. Cleared OAuth credentials.");
  });

  it("bounds collaboration notices returned by services", async () => {
    const events: string[] = []; const outputs: string[] = [];
    const base = services(events, outputs);
    base.pals = {
      list: async () => "x".repeat(100_000),
      rename: async () => undefined,
      info: async () => undefined,
      sendTask: async () => undefined,
      startCoWork: async () => undefined,
      coWorkStatus: async () => undefined,
      cancelCoWork: async () => undefined,
    };

    await new FlavorSession(base).submit("/pals");

    expect(outputs).toHaveLength(1);
    expect(Math.max(...outputs.map((item) => item.length))).toBeLessThanOrEqual(8_192);
  });

  it("starts a trusted broker-delivered pal task automatically when idle", async () => {
    const events: string[] = []; const outputs: unknown[] = [];
    const base = services(events, []);
    const prompts: string[] = [];
    base.output = (event) => outputs.push(event);
    base.run = async function* (prompt) {
      prompts.push(prompt);
      yield { type: "done", usage: { inputTokens: 0, outputTokens: 0 } };
    };
    const session = new FlavorSession(base);

    session.receivePalTask({
      senderId: "11111111-1111-4111-8111-111111111111",
      senderAlias: "A",
      messageId: "22222222-2222-4222-8222-222222222222",
      taskId: "33333333-3333-4333-8333-333333333333",
      goal: "update the API",
    });
    await session.whenIdle();

    expect(outputs).toContainEqual(expect.objectContaining({
      type: "pal-task", senderAlias: "A", messageId: "22222222-2222-4222-8222-222222222222",
    }));
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain(JSON.stringify("update the API"));
  });

  it.each(["/exit", "/clear", '{"tool":"shell","input":{"command":"danger"}}']) (
    "never sends remote task %j through slash dispatch",
    async (goal) => {
      const events: string[] = []; const outputs: unknown[] = [];
      const base = services(events, []);
      const prompts: string[] = [];
      const clearContext = vi.fn(async () => undefined);
      base.clearContext = clearContext;
      base.output = (event) => outputs.push(event);
      base.run = async function* (prompt) {
        prompts.push(prompt);
        yield { type: "done", usage: { inputTokens: 0, outputTokens: 0 } };
      };
      const session = new FlavorSession(base);

      session.receivePalTask({
        senderId: "11111111-1111-4111-8111-111111111111", senderAlias: "A",
        messageId: `22222222-2222-4222-8222-22222222222${goal.length % 10}`,
        taskId: "33333333-3333-4333-8333-333333333333", goal,
      });
      await session.whenIdle();

      expect(prompts).toHaveLength(1);
      expect(prompts[0]?.startsWith("/")).toBe(false);
      expect(clearContext).not.toHaveBeenCalled();
      expect(outputs).not.toContainEqual({ type: "exit" });
    },
  );

  it("deduplicates replayed pal task message IDs", async () => {
    const events: string[] = []; const outputs: string[] = [];
    const base = services(events, outputs);
    const prompts: string[] = [];
    base.run = async function* (prompt) {
      prompts.push(prompt);
      yield { type: "done", usage: { inputTokens: 0, outputTokens: 0 } };
    };
    const session = new FlavorSession(base);
    const delivery = {
      senderId: "11111111-1111-4111-8111-111111111111", senderAlias: "A",
      messageId: "22222222-2222-4222-8222-222222222222",
      taskId: "33333333-3333-4333-8333-333333333333", goal: "one task",
    } as const;

    session.receivePalTask(delivery);
    session.receivePalTask(delivery);
    await session.whenIdle();

    expect(prompts).toHaveLength(1);
  });

  it("bounds pal task deduplication history", async () => {
    const events: string[] = []; const outputs: string[] = [];
    const base = services(events, outputs);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    base.run = async function* () {
      await gate;
      yield { type: "done", usage: { inputTokens: 0, outputTokens: 0 } };
    };
    const session = new FlavorSession(base);
    const active = session.submit("local task");
    await new Promise((resolve) => setTimeout(resolve, 0));
    const delivery = (index: number) => ({
      senderId: "peer-a", senderAlias: "A", messageId: `message-${index}`,
      taskId: `task-${index}`, goal: `goal-${index}`,
    });

    for (let index = 0; index <= 2_048; index += 1) session.receivePalTask(delivery(index));
    session.receivePalTask(delivery(0));

    expect(session.queueSnapshot().steering).toHaveLength(2_050);
    session.clearQueue();
    release();
    await active;
  });

  it("steers an active model run with an inbound pal task without starting a parallel run", async () => {
    const events: string[] = []; const outputs: string[] = [];
    const base = services(events, outputs);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const calls: Array<{ prompt: string; steering: () => readonly string[] }> = [];
    base.run = async function* (prompt, _signal, options) {
      calls.push({ prompt, steering: options!.getSteeringMessages });
      await gate;
      yield { type: "done", usage: { inputTokens: 0, outputTokens: 0 } };
    };
    const session = new FlavorSession(base);
    const active = session.submit("local task");
    await new Promise((resolve) => setTimeout(resolve, 0));

    session.receivePalTask({
      senderId: "11111111-1111-4111-8111-111111111111", senderAlias: "A",
      messageId: "22222222-2222-4222-8222-222222222222",
      taskId: "33333333-3333-4333-8333-333333333333", goal: "coordinate now",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.steering()).toEqual([expect.stringContaining(JSON.stringify("coordinate now"))]);
    release();
    await active;
    await session.whenIdle();

    expect(calls).toHaveLength(1);
  });

  it("queues a pal task as follow-up when a local submission is pending but not active", async () => {
    const events: string[] = []; const outputs: unknown[] = [];
    const base = services(events, []);
    base.output = (event) => outputs.push(event);
    let releaseStart!: () => void;
    const startGate = new Promise<void>((resolve) => { releaseStart = resolve; });
    base.hooks.on("SessionStart", async () => {
      await startGate;
      return { decision: "allow" };
    });
    const prompts: string[] = [];
    base.run = async function* (prompt) {
      prompts.push(prompt);
      yield { type: "done", usage: { inputTokens: 0, outputTokens: 0 } };
    };
    const session = new FlavorSession(base);
    const local = session.submit("local first");

    session.receivePalTask({
      senderId: "11111111-1111-4111-8111-111111111111", senderAlias: "A",
      messageId: "22222222-2222-4222-8222-222222222222",
      taskId: "33333333-3333-4333-8333-333333333333", goal: "remote second",
    });
    releaseStart();
    await local;
    await session.whenIdle();

    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toBe("local first");
    expect(prompts[1]).toContain(JSON.stringify("remote second"));
    expect(outputs).toContainEqual(expect.objectContaining({
      type: "queued-remote-prompt", prompt: "remote second", senderAlias: "A",
    }));
    expect(outputs).not.toContainEqual(expect.objectContaining({
      type: "queued-prompt", prompt: expect.stringContaining("trusted local broker"),
    }));
  });

  it("keeps inbound task errors inside the normal session lifecycle", async () => {
    const events: string[] = []; const outputs: unknown[] = [];
    const base = services(events, []);
    base.output = (event) => outputs.push(event);
    base.run = async function* () { throw new Error("remote work failed"); };
    const session = new FlavorSession(base);

    session.receivePalTask({
      senderId: "11111111-1111-4111-8111-111111111111", senderAlias: "A",
      messageId: "22222222-2222-4222-8222-222222222222",
      taskId: "33333333-3333-4333-8333-333333333333", goal: "fail safely",
    });
    await expect(session.whenIdle()).resolves.toBeUndefined();

    expect(outputs).toContainEqual(expect.objectContaining({ type: "error" }));
    expect(events.at(-1)).toBe("Stop");
    expect(session.active).toBe(false);
  });

  it("plans co-work under plan permission, steers revisions, then restores permission at START", async () => {
    const events: string[] = []; const outputs: unknown[] = [];
    const base = services(events, []);
    const prompts: Array<{ prompt: string; steering: () => readonly string[] }> = [];
    let permission: "default" | "plan" = "default";
    const permissionChanges: string[] = [];
    base.permissionMode = () => permission;
    base.setPermissionMode = async (next) => { permission = next as typeof permission; permissionChanges.push(next); };
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    base.output = (event) => outputs.push(event);
    base.run = async function* (prompt, _signal, options) {
      prompts.push({ prompt, steering: options!.getSteeringMessages });
      await gate;
      yield { type: "done", usage: { inputTokens: 0, outputTokens: 0 } };
    };
    const session = new FlavorSession(base);
    const snapshot = {
      version: 1 as const,
      coWorkId: "44444444-4444-4444-8444-444444444444",
      epoch: 1,
      phase: "planning",
      goal: "upgrade API",
      participants: [
        { palId: "11111111-1111-4111-8111-111111111111", required: true },
        { palId: "22222222-2222-4222-8222-222222222222", required: true },
      ],
      integrationOwnerId: "11111111-1111-4111-8111-111111111111",
      acceptedParticipantIds: ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"],
      planHash: "a".repeat(64),
      plan: {
        version: 1 as const, coWorkId: "44444444-4444-4444-8444-444444444444", epoch: 1, goal: "upgrade API",
        participants: [
          { palId: "11111111-1111-4111-8111-111111111111", required: true },
          { palId: "22222222-2222-4222-8222-222222222222", required: true },
        ],
        tasks: [
          { id: "remote", assigneeId: "11111111-1111-4111-8111-111111111111", description: "change server", dependsOn: [] },
          { id: "local", assigneeId: "22222222-2222-4222-8222-222222222222", description: "adapt client", dependsOn: ["remote"] },
        ],
      },
      planAcceptedParticipantIds: [], readyParticipantIds: [], completedParticipantIds: [], completionAssertions: [], integration: null,
    } as const;
    const common = {
      senderId: "11111111-1111-4111-8111-111111111111", senderAlias: "A",
      localId: "22222222-2222-4222-8222-222222222222",
      coWorkId: snapshot.coWorkId, epoch: 1, planHash: snapshot.planHash, snapshot,
    } as const;

    await session.receivePalCoWorkEvent({ ...common, action: "PROPOSE", planHash: null });
    await vi.waitFor(() => expect(prompts).toHaveLength(1));
    expect(permission).toBe("plan");
    expect(prompts[0]!.prompt).toContain("CoWorkState");
    expect(prompts[0]!.prompt).toContain("wait for broker START");
    await session.receivePalCoWorkEvent({ ...common, action: "PLAN" });
    await vi.waitFor(() => expect(prompts[0]!.steering()).toHaveLength(1));
    expect(permission).toBe("plan");
    const start = session.receivePalCoWorkEvent({ ...common, action: "START" });
    void session.receivePalCoWorkEvent({ ...common, action: "START" });
    let stopSteering: readonly string[] = [];
    await vi.waitFor(() => {
      stopSteering = prompts[0]!.steering();
      expect(stopSteering).toHaveLength(1);
    });
    expect(stopSteering[0]).toContain("START");
    expect(permission).toBe("plan");
    release();
    await start;
    await session.whenIdle();
    expect(permission).toBe("default");
    const startPrompt = prompts[1]!.prompt;
    expect(startPrompt).toContain("adapt client");
    expect(startPrompt).not.toContain("change server");

    expect(outputs.filter((event) => (event as { type?: string }).type === "cowork-event")).toHaveLength(3);
    expect(prompts).toHaveLength(2);
    expect(permissionChanges).toEqual(["plan", "default"]);
  });

  it("restores the prior permission when a co-work FAILs before START", async () => {
    const events: string[] = []; const outputs: unknown[] = [];
    const base = services(events, []);
    let permission: "default" | "plan" = "default";
    base.permissionMode = () => permission;
    base.setPermissionMode = async (next) => { permission = next as typeof permission; };
    base.output = (event) => outputs.push(event);
    base.run = async function* () { yield { type: "done", usage: { inputTokens: 0, outputTokens: 0 } }; };
    const session = new FlavorSession(base);
    const common = {
      senderId: "11111111-1111-4111-8111-111111111111", senderAlias: "A",
      localId: "22222222-2222-4222-8222-222222222222",
      coWorkId: "44444444-4444-4444-8444-444444444444", epoch: 1, planHash: null,
      snapshot: { phase: "failed", completionAssertions: [{ participantId: "11111111-1111-4111-8111-111111111111", passed: false, detail: "tests failed" }] },
    } as const;

    session.receivePalCoWorkEvent({ ...common, action: "PROPOSE" });
    await vi.waitFor(() => expect(permission).toBe("plan"));
    session.receivePalCoWorkEvent({ ...common, action: "FAIL" });
    await vi.waitFor(() => expect(permission).toBe("default"));
    expect(outputs).toContainEqual(expect.objectContaining({ type: "cowork-event", action: "FAIL" }));
  });

  it("holds all START execution until the aggregate planning gate resolves and ignores a stale epoch", async () => {
    const events: string[] = []; const outputs: unknown[] = [];
    const base = services(events, []);
    let permission: "acceptEdits" | "plan" = "acceptEdits";
    const permissionChanges: string[] = [];
    const prompts: Array<{ prompt: string; permission: string }> = [];
    base.permissionMode = () => permission;
    base.setPermissionMode = async (next) => { permission = next as typeof permission; permissionChanges.push(next); };
    base.output = (event) => outputs.push(event);
    base.run = async function* (prompt) {
      prompts.push({ prompt, permission });
      yield { type: "done", usage: { inputTokens: 0, outputTokens: 0 } };
    };
    const session = new FlavorSession(base);
    const delivery = (coWorkId: string, action: "PROPOSE" | "PLAN" | "START", epoch = 1): PalCoWorkDelivery => ({
      senderId: "11111111-1111-4111-8111-111111111111", senderAlias: "A",
      localId: "22222222-2222-4222-8222-222222222222", coWorkId, epoch, action,
      planHash: action === "PROPOSE" ? null : "a".repeat(64),
      snapshot: {
        goal: `goal-${coWorkId}`, integrationOwnerId: "11111111-1111-4111-8111-111111111111",
        plan: { tasks: [{ id: "local", assigneeId: "22222222-2222-4222-8222-222222222222", description: `execute-${coWorkId}`, dependsOn: [] }] },
      },
    } as PalCoWorkDelivery);
    const a = "44444444-4444-4444-8444-444444444441";
    const b = "44444444-4444-4444-8444-444444444442";

    await session.receivePalCoWorkEvent(delivery(a, "PROPOSE"));
    await session.whenIdle();
    await session.receivePalCoWorkEvent(delivery(b, "PROPOSE"));
    await session.whenIdle();
    expect(permission).toBe("plan");

    await session.receivePalCoWorkEvent(delivery(a, "START"));
    await session.whenIdle();
    expect(permission).toBe("plan");
    expect(prompts.some(({ prompt }) => prompt.includes("authorized co-work START") && prompt.includes(`execute-${a}`))).toBe(false);

    await session.receivePalCoWorkEvent(delivery(b, "START"));
    await session.whenIdle();
    expect(permission).toBe("acceptEdits");
    expect(prompts.filter(({ prompt }) => prompt.includes("authorized co-work START"))).toEqual([
      expect.objectContaining({ prompt: expect.stringContaining(`execute-${a}`), permission: "acceptEdits" }),
      expect.objectContaining({ prompt: expect.stringContaining(`execute-${b}`), permission: "acceptEdits" }),
    ]);
    expect(permissionChanges.filter((mode) => mode === "acceptEdits")).toHaveLength(1);

    await session.receivePalCoWorkEvent(delivery(a, "PLAN"));
    await session.whenIdle();
    expect(permission).toBe("acceptEdits");
    const promptCount = prompts.length;
    await session.receivePalCoWorkEvent(delivery(a, "PROPOSE", 2));
    await session.whenIdle();
    expect(permission).toBe("plan");
    expect(prompts).toHaveLength(promptCount + 1);
  });

  it("queues a busy co-work invitation without changing permissions under unrelated work", async () => {
    const events: string[] = []; const outputs: unknown[] = [];
    const base = services(events, []);
    let permission: "acceptEdits" | "plan" = "acceptEdits";
    let releaseLocal!: () => void;
    const localGate = new Promise<void>((resolve) => { releaseLocal = resolve; });
    const prompts: Array<{ prompt: string; permission: string }> = [];
    base.permissionMode = () => permission;
    base.setPermissionMode = async (next) => { permission = next as typeof permission; };
    base.output = (event) => outputs.push(event);
    base.run = async function* (prompt) {
      prompts.push({ prompt, permission });
      if (prompt === "unrelated local work") await localGate;
      yield { type: "done", usage: { inputTokens: 0, outputTokens: 0 } };
    };
    const session = new FlavorSession(base);
    const local = session.submit("unrelated local work");
    await vi.waitFor(() => expect(session.active).toBe(true));

    await session.receivePalCoWorkEvent({
      senderId: "11111111-1111-4111-8111-111111111111", senderAlias: "backend",
      coWorkId: "44444444-4444-4444-8444-444444444448", epoch: 1,
      action: "PROPOSE", planHash: null, snapshot: { goal: "coordinate safely" },
    });
    expect(permission).toBe("acceptEdits");
    expect(session.active).toBe(true);

    releaseLocal();
    await local;
    await session.whenIdle();
    expect(prompts).toEqual([
      { prompt: "unrelated local work", permission: "acceptEdits" },
      expect.objectContaining({ prompt: expect.stringContaining("co-work PROPOSE"), permission: "plan" }),
    ]);
    expect(outputs).toContainEqual(expect.objectContaining({
      type: "queued-remote-prompt", senderAlias: "backend", prompt: "coordinate safely", context: "CO-WORK PLANNING",
    }));
  });

  it.each(["CANCEL", "FAIL", "END"] as const)(
    "stops an active matching planning turn before restoring permission on %s",
    async (action) => {
      const events: string[] = []; const outputs: unknown[] = [];
      const base = services(events, []);
      let permission: "default" | "plan" = "default";
      const steering: string[] = [];
      const prompts: string[] = [];
      const cancelled = vi.fn(async () => undefined);
      base.permissionMode = () => permission;
      base.setPermissionMode = async (next) => { permission = next as typeof permission; };
      base.cancelActiveTask = cancelled;
      base.output = (event) => outputs.push(event);
      base.run = async function* (prompt, signal, options) {
        prompts.push(prompt);
        try {
          while (!signal.aborted) {
            steering.push(...(options?.getSteeringMessages() ?? []));
            await new Promise((resolve) => setTimeout(resolve, 1));
          }
        } finally {
          steering.push(...(options?.getSteeringMessages() ?? []));
        }
      };
      const session = new FlavorSession(base);
      const common = {
        senderId: "11111111-1111-4111-8111-111111111111", senderAlias: "backend",
        coWorkId: "44444444-4444-4444-8444-444444444449", epoch: 1, planHash: null,
        snapshot: { goal: "coordinate", phase: "planning" },
      } as const;

      await session.receivePalCoWorkEvent({ ...common, action: "PROPOSE" });
      await vi.waitFor(() => expect(session.active).toBe(true));
      await session.receivePalCoWorkEvent({ ...common, action });

      expect(session.active).toBe(false);
      expect(permission).toBe("default");
      expect(cancelled).toHaveBeenCalledOnce();
      expect(steering.join("\n")).toMatch(new RegExp(`backend.*${action}|${action}.*backend`, "i"));
      expect(prompts).toHaveLength(1);
    },
  );

  it("cancels planning and restores the aggregate baseline when the session closes", async () => {
    const events: string[] = []; const outputs: unknown[] = [];
    const base = services(events, []);
    let permission: "acceptEdits" | "plan" = "acceptEdits";
    base.permissionMode = () => permission;
    base.setPermissionMode = async (next) => { permission = next as typeof permission; };
    base.output = (event) => outputs.push(event);
    base.run = async function* (_prompt, signal) {
      while (!signal.aborted) await new Promise((resolve) => setTimeout(resolve, 1));
    };
    const session = new FlavorSession(base);
    await session.receivePalCoWorkEvent({
      senderId: "11111111-1111-4111-8111-111111111111", senderAlias: "backend",
      coWorkId: "44444444-4444-4444-8444-444444444447", epoch: 1,
      action: "PROPOSE", planHash: null, snapshot: { goal: "coordinate" },
    });
    await vi.waitFor(() => expect(permission).toBe("plan"));

    await session.close();

    expect(session.active).toBe(false);
    expect(permission).toBe("acceptEdits");
  });
  it("forwards UserPromptSubmit context to the prompt-scoped model run", async () => {
    const events: string[] = []; const outputs: string[] = [];
    const base = services(events, outputs);
    base.hooks.on("UserPromptSubmit", () => ({
      decision: "allow",
      additionalContext: "The previous task plan was cancelled; create a fresh plan.",
    }));
    const contexts: Array<string | undefined> = [];
    base.run = async function* (_prompt, _signal, options) {
      contexts.push(options?.additionalContext);
      yield { type: "done", usage: { inputTokens: 0, outputTokens: 0 } };
    };

    await new FlavorSession(base).submit("continue with the revised requirement");

    expect(contexts).toEqual([
      "The previous task plan was cancelled; create a fresh plan.",
    ]);
  });

  it("forwards image content only to a normal main-model prompt", async () => {
    const events: string[] = []; const outputs: string[] = [];
    const base = services(events, outputs);
    const calls: unknown[] = [];
    base.run = async function* (prompt, _signal, options) {
      calls.push({ prompt, initialUserMessage: options?.initialUserMessage });
      yield { type: "done", usage: { inputTokens: 0, outputTokens: 0 } };
    };
    const session = new FlavorSession(base);
    await session.submit({
      text: "Inspect this screenshot",
      content: [
        { type: "text", text: "Inspect this screenshot" },
        {
          type: "image",
          source: { type: "file", path: "C:\\assets\\screen.png" },
          mediaType: "image/png",
          sha256: "a".repeat(64),
          bytes: 8,
        },
      ],
    });

    expect(calls).toEqual([{
      prompt: "Inspect this screenshot",
      initialUserMessage: expect.objectContaining({
        role: "user",
        content: expect.arrayContaining([expect.objectContaining({ type: "image" })]),
      }),
    }]);
  });

  it("shares startup, serializes submissions, and ends only after Stop", async () => {
    const events: string[] = []; const outputs: string[] = [];
    const base = services(events, outputs);
    let releaseStart!: () => void;
    const startGate = new Promise<void>((resolve) => { releaseStart = resolve; });
    base.hooks.on("SessionStart", async () => {
      await startGate;
      return { decision: "allow" };
    });
    const order: string[] = [];
    base.run = async function* (prompt) {
      order.push(`run:${prompt}`); yield { type: "done", usage: { inputTokens: 0, outputTokens: 0 } };
    };
    const session = new FlavorSession(base);
    const startOne = session.start(); const startTwo = session.start();
    const first = session.submit("one"); const second = session.submit("two");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(order).toEqual([]);
    releaseStart(); await Promise.all([startOne, startTwo, first, second]);
    await session.close();
    expect(events.filter((event) => event === "SessionStart")).toHaveLength(1);
    expect(order).toEqual(["run:one", "run:two"]);
    expect(events.slice(-2)).toEqual(["Stop", "SessionEnd"]);
  });

  it("reports a failed Stop outcome when the agent stream returns an error event", async () => {
    const events: string[] = []; const outputs: string[] = [];
    const base = services(events, outputs);
    const outcomes: unknown[] = [];
    base.hooks.on("Stop", (event) => {
      outcomes.push(event.payload.outcome);
      return { decision: "allow" };
    });
    base.run = async function* () {
      yield { type: "error", error: { code: "authentication", message: "expired token" } };
    };

    await new FlavorSession(base).submit("run a task");

    expect(outcomes).toEqual(["failed"]);
  });

  it("queues steering for an active run and follow-up work for after it", async () => {
    const events: string[] = []; const outputs: string[] = [];
    const base = services(events, outputs);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const calls: Array<{ prompt: string; steering?: () => readonly string[] }> = [];
    base.run = async function* (prompt, _signal, options) {
      calls.push({
        prompt,
        ...(options?.getSteeringMessages === undefined ? {} : { steering: options.getSteeringMessages }),
      });
      if (prompt === "first") await gate;
      yield { type: "done", usage: { inputTokens: 0, outputTokens: 0 } };
    };
    const session = new FlavorSession(base);

    const active = session.submit("first");
    await new Promise((resolve) => setTimeout(resolve, 0));
    session.steer("change direction");
    session.followUp("then add tests");
    expect(outputs).toContain("Steering queued (1 pending).");
    expect(outputs).toContain("Follow-up queued (1 pending).");
    expect(session.queueSnapshot()).toEqual({
      steering: ["change direction"],
      followUp: ["then add tests"],
    });
    expect(calls[0]?.steering?.()).toEqual(["change direction"]);
    release();
    await active;
    await session.whenIdle();

    expect(calls.map((call) => call.prompt)).toEqual(["first", "then add tests"]);
    expect(outputs).toContain("queued-prompt");
    expect(session.queueSnapshot()).toEqual({ steering: [], followUp: [] });
  });

  it("starts an idle steering message as a normal submission", async () => {
    const events: string[] = []; const outputs: string[] = [];
    const base = services(events, outputs);
    const prompts: string[] = [];
    base.run = async function* (prompt) {
      prompts.push(prompt);
      yield { type: "done", usage: { inputTokens: 0, outputTokens: 0 } };
    };
    const session = new FlavorSession(base);

    session.steer("start now");
    await session.whenIdle();

    expect(prompts).toEqual(["start now"]);
  });

  it("keeps steering intent when it arrives before the queued run becomes active", async () => {
    const events: string[] = []; const outputs: string[] = [];
    const base = services(events, outputs);
    const steering: string[][] = [];
    base.run = async function* (_prompt, _signal, options) {
      steering.push([...(options?.getSteeringMessages() ?? [])]);
      yield { type: "done", usage: { inputTokens: 0, outputTokens: 0 } };
    };
    const session = new FlavorSession(base);

    const pending = session.submit("first");
    session.steer("early adjustment");
    await pending;

    expect(steering).toEqual([["early adjustment"]]);
  });

  it("close waits for an active cancellation and Stop before SessionEnd", async () => {
    const events: string[] = []; const outputs: string[] = [];
    const base = services(events, outputs);
    base.run = async function* (_prompt, signal) {
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      yield { type: "error", error: { code: "cancelled", message: "cancelled" } };
    };
    const session = new FlavorSession(base); await session.start();
    const pending = session.submit("wait"); await new Promise((resolve) => setTimeout(resolve, 0));
    session.interrupt();
    await session.close(); await pending;
    expect(events.slice(-2)).toEqual(["Stop", "SessionEnd"]);
  });
  it("balances lifecycle hooks and streams prompt output", async () => {
    const events: string[] = []; const outputs: string[] = [];
    const session = new FlavorSession(services(events, outputs));
    await session.start();
    await session.submit("hello");
    await session.close();
    expect(events).toEqual(["SessionStart", "UserPromptSubmit", "Stop", "SessionEnd"]);
    expect(outputs).toContain("hel"); expect(outputs).toContain("lo");
  });

  it("persists SessionStart additionalContext before the first run", async () => {
    const events: string[] = []; const outputs: string[] = [];
    const base = services(events, outputs);
    const addContext = vi.fn();
    base.addContext = addContext;
    base.hooks.on("SessionStart", () => ({ decision: "allow", additionalContext: "project harness rules" }));
    const session = new FlavorSession(base);

    await session.submit("hello");

    expect(addContext).toHaveBeenCalledOnce();
    expect(addContext).toHaveBeenCalledWith("project harness rules");
  });

  it("first interrupt cancels an active run and second requests exit", async () => {
    const events: string[] = []; const outputs: string[] = [];
    const base = services(events, outputs);
    base.run = async function* (_prompt, signal) {
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      yield { type: "error", error: { code: "cancelled", message: "cancelled" } };
    };
    const session = new FlavorSession(base); await session.start();
    const pending = session.submit("wait");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(session.interrupt()).toBe("cancelled");
    await pending;
    expect(session.interrupt()).toBe("exit");
    await session.close();
    expect(events.filter((event) => event === "Stop")).toHaveLength(1);
  });

  it("asks services to cancel the active plan task when interrupted", async () => {
    const events: string[] = []; const outputs: string[] = [];
    const base = services(events, outputs);
    let cancelled = 0;
    base.cancelActiveTask = async () => { cancelled += 1; };
    base.run = async function* (_prompt, signal) {
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      yield { type: "error", error: { code: "cancelled", message: "cancelled" } };
    };
    const session = new FlavorSession(base); await session.start();
    const pending = session.submit("complex work");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(session.interrupt()).toBe("cancelled");
    await pending;

    expect(cancelled).toBe(1);
  });

  it("clears the active run and emits Stop when task cancellation publication fails", async () => {
    const events: string[] = []; const outputs: string[] = [];
    const base = services(events, outputs);
    base.cancelActiveTask = async () => { throw new Error("task state unavailable"); };
    base.run = async function* (_prompt, signal) {
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    };
    const session = new FlavorSession(base); await session.start();
    const pending = session.submit("complex work");
    await new Promise((resolve) => setTimeout(resolve, 0));
    session.interrupt();

    await expect(pending).resolves.toBeUndefined();
    expect(session.active).toBe(false);
    expect(events.at(-1)).toBe("Stop");
    expect(outputs).toContain("error");
  });

  it("redacts secrets from config output", async () => {
    const events: string[] = []; const outputs: string[] = [];
    const session = new FlavorSession(services(events, outputs)); await session.start();
    await session.submit("/config"); await session.close();
    const rendered = outputs.join("\n");
    expect(rendered).not.toContain("top-secret"); expect(rendered).not.toContain("also-secret");
    expect(rendered).toContain("[redacted]");
  });

  it("runs an explicitly selected skill with its argument text", async () => {
    const events: string[] = []; const outputs: string[] = [];
    const base = services(events, outputs);
    const calls: Array<{ skill: string; prompt: string }> = [];
    base.skills = async () => [{
      name: "frontend-design", description: "Design interfaces", source: "project", root: "/work/.flavor/skills/frontend-design",
      disableModelInvocation: false,
    }];
    base.run = async function* () { throw new Error("ordinary run must not be called"); };
    base.runSkill = async function* (skill, prompt) {
      calls.push({ skill, prompt });
      yield { type: "text", text: "done" };
    };

    const session = new FlavorSession(base);
    await session.submit("/frontend-design polish footer");

    expect(calls).toEqual([{ skill: "frontend-design", prompt: "polish footer" }]);
    expect(outputs).toContain("done");
  });

  it("runs /loop with the remaining input as its goal", async () => {
    const events: string[] = []; const outputs: string[] = [];
    const base = services(events, outputs);
    const goals: string[] = [];
    base.runLoop = async function* (goal) {
      goals.push(goal);
      yield { type: "text", text: "looping" };
      yield { type: "done", usage: { inputTokens: 2, outputTokens: 1 } };
    };

    const session = new FlavorSession(base);
    await session.submit("/loop fix all type errors");

    expect(goals).toEqual(["fix all type errors"]);
    expect(outputs).toContain("looping");
  });

  it("dispatches MCP management commands without invoking the model", async () => {
    const events: string[] = []; const outputs: string[] = [];
    const base = services(events, outputs);
    const mcp = vi.fn(async () => "filesystem  connected  stdio  14 tools");
    Object.assign(base, { mcp });
    base.run = async function* () { throw new Error("ordinary run must not be called"); };
    const session = new FlavorSession(base);

    await session.submit("/mcp reconnect filesystem");

    expect(mcp).toHaveBeenCalledWith({ name: "mcp", action: "reconnect", target: "filesystem" }, expect.any(AbortSignal));
    expect(outputs).toContain("filesystem  connected  stdio  14 tools");
  });

  it("reports IDE connection state without invoking the model", async () => {
    const events: string[] = []; const outputs: string[] = [];
    const base = services(events, outputs);
    const ide = vi.fn(async () => "Connected to Visual Studio Code: src/main.ts:6:9.");
    Object.assign(base, { ide });
    base.run = async function* () { throw new Error("ordinary run must not be called"); };
    const session = new FlavorSession(base);

    await session.submit("/ide");

    expect(ide).toHaveBeenCalledOnce();
    expect(outputs).toContain("Connected to Visual Studio Code: src/main.ts:6:9.");
  });

  it("dispatches long-term-memory commands without invoking the model", async () => {
    const events: string[] = []; const outputs: string[] = [];
    const base = services(events, outputs);
    const remember = vi.fn(async () => "Remembered project memory abc123.");
    const forget = vi.fn(async () => "Forgot 1 memory entry.");
    const memory = vi.fn(async () => "# Flavor Project Memory");
    Object.assign(base, { remember, forget, memory });
    base.run = async function* () { throw new Error("ordinary run must not be called"); };
    const session = new FlavorSession(base);

    await session.submit("/remember project Use pnpm for scripts");
    await session.submit("/memory");
    await session.submit("/forget pnpm");

    expect(remember).toHaveBeenCalledWith("project", "Use pnpm for scripts");
    expect(memory).toHaveBeenCalledOnce();
    expect(forget).toHaveBeenCalledWith("pnpm");
    expect(outputs).toContain("Remembered project memory abc123.");
    expect(outputs).toContain("Forgot 1 memory entry.");
  });

  it("dispatches the explicit finish command to the task finalizer", async () => {
    const events: string[] = []; const outputs: string[] = [];
    const base = services(events, outputs);
    const finishTask = vi.fn(async () => "Task completed; review 2 memory candidates.");
    Object.assign(base, { finishTask });
    base.run = async function* () { throw new Error("ordinary run must not be called"); };
    const session = new FlavorSession(base);

    await session.submit("/finish");

    expect(finishTask).toHaveBeenCalledOnce();
    expect(outputs).toContain("Task completed; review 2 memory candidates.");
  });

  it("dispatches checkpoint and session tree commands without invoking the model", async () => {
    const events: string[] = []; const outputs: string[] = [];
    const base = services(events, outputs);
    const checkpoint = vi.fn(async () => ({ id: "turn-1", checkpointId: "checkpoint-1" }));
    const tree = vi.fn(() => [{ id: "turn-1", parentId: null }]);
    const rewind = vi.fn(async () => undefined);
    const unrevert = vi.fn(async () => undefined);
    const fork = vi.fn(async () => undefined);
    Object.assign(base, { checkpoint, tree, rewind, unrevert, fork });
    base.run = async function* () { throw new Error("ordinary run must not be called"); };
    const session = new FlavorSession(base);

    await session.submit("/checkpoint before refactor");
    await session.submit("/tree");
    await session.submit("/rewind turn-1");
    await session.submit("/unrevert");
    await session.submit("/fork turn-1");

    expect(checkpoint).toHaveBeenCalledWith("before refactor");
    expect(tree).toHaveBeenCalledOnce();
    expect(rewind).toHaveBeenCalledWith("turn-1");
    expect(unrevert).toHaveBeenCalledOnce();
    expect(fork).toHaveBeenCalledWith("turn-1");
    expect(outputs.join("\n")).toContain("checkpoint-1");
  });
});
