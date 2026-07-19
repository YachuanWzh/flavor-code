import { describe, expect, it, vi } from "vitest";

import { HookBus } from "../../src/hooks/bus.js";
import { QuestionBridge } from "../../src/tools/ask-user-question.js";
import { FlavorSession, type SessionServices } from "../../src/ui/session.js";

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
    mcp: async () => "No MCP servers configured.",
    setModel: () => {}, setPermissionMode: () => {}, compact: async () => false,
    initialize: async () => ({ path: "/work/FLAVOR.md", created: true }),
    config: () => ({ providers: { openai: { apiKey: "top-secret", token: "also-secret" } } }),
    skills: async () => [], plugins: () => [], hooksStatus: () => [], tasks: () => [], audit: async () => "", cancelActiveTask: async () => {},
    clearContext: async () => {},
    pluginCommands: () => [], runPluginCommand: async () => undefined,
    output: (event) => outputs.push(event.type === "text" ? event.text : event.type === "notice" ? event.message : event.type),
    questions,
    login: async () => "authenticated",
  };
}

describe("FlavorSession", () => {
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
});
