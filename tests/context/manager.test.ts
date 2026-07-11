import { describe, expect, it } from "vitest";

import { HookBus } from "../../src/hooks/bus.js";
import { ContextManager, estimateTokens } from "../../src/context/manager.js";

describe("ContextManager", () => {
  it("truncates tool output to head and tail with original length metadata", () => {
    const context = createContext({ toolOutputChars: 10 });

    context.append({ role: "tool", content: "abcdefghijklmnopqrst", toolCallId: "call-1" });

    const tool = context.messagesForModel().at(-1);
    expect(tool?.content).toContain("abcde");
    expect(tool?.content).toContain("pqrst");
    expect(tool?.content).toContain("original length: 20 characters");
    expect(tool?.toolCallId).toBe("call-1");
  });

  it("compacts older messages while retaining pinned context and recent turns", async () => {
    const hooks = new HookBus();
    const events: string[] = [];
    hooks.on("PreCompact", (event) => { events.push(event.type); return { decision: "allow" }; });
    hooks.on("PostCompact", (event) => { events.push(event.type); return { decision: "allow" }; });
    const summarized: string[][] = [];
    const context = createContext({
      hooks,
      compactAtChars: 1,
      recentTurns: 1,
      summarize: async (messages) => {
        summarized.push(messages.map((message) => message.content));
        return "structured summary";
      },
    });
    context.append({ role: "user", content: "old question" });
    context.append({ role: "assistant", content: "old answer" });
    context.append({ role: "user", content: "recent question" });
    context.append({ role: "assistant", content: "recent answer" });

    expect(await context.compact()).toBe(true);

    expect(summarized).toEqual([["old question", "old answer"]]);
    expect(events).toEqual(["PreCompact", "PostCompact"]);
    expect(context.messagesForModel().map((message) => message.content)).toEqual([
      "system instructions",
      "FLAVOR.md\nproject guidance",
      "Task state\nin progress",
      "Conversation summary\nstructured summary",
      "recent question",
      "recent answer",
    ]);
  });

  it("keeps the latest tool exchange as one recent turn", async () => {
    const context = createContext({ compactAtChars: 1, recentTurns: 1 });
    context.append({ role: "user", content: "old" });
    context.append({ role: "assistant", content: "old reply" });
    context.append({ role: "user", content: "use a tool" });
    context.append({ role: "assistant", content: "", toolCalls: [{ id: "c", name: "echo", input: {} }] });
    context.append({ role: "tool", content: "result", toolCallId: "c" });
    context.append({ role: "assistant", content: "tool reply" });

    await context.compact();

    expect(context.messagesForModel().slice(-4).map((message) => message.role)).toEqual(["user", "assistant", "tool", "assistant"]);
  });

  it("uses the documented character token estimate", () => {
    expect(estimateTokens("12345")).toBe(2);
  });

  it("includes model-visible tool-call arguments in compaction sizing", () => {
    const context = createContext({ compactAtChars: 100, recentTurns: 0 });
    context.append({
      role: "assistant",
      content: "",
      toolCalls: [{ id: "call", name: "echo", input: { value: "x".repeat(200) } }],
    });
    expect(context.needsCompaction()).toBe(true);
    expect(context.estimatedTokens()).toBeGreaterThan(50);
  });

  it("uses the same separator-inclusive character count for the threshold and token estimate", () => {
    const context = new ContextManager({
      system: "a",
      compactAtChars: 3,
      toolOutputChars: 100,
      summarize: async () => "summary",
      hooks: new HookBus(),
    });
    context.append({ role: "user", content: "b" });
    expect(context.estimatedTokens()).toBe(1);
    expect(context.needsCompaction()).toBe(true);
  });

  it("aborts summarization promptly without allowing a late result to mutate context", async () => {
    const controller = new AbortController();
    let finish!: (summary: string) => void;
    let receivedSignal: AbortSignal | undefined;
    const context = createContext({
      compactAtChars: 1,
      recentTurns: 0,
      summarize: (_messages, signal) => {
        receivedSignal = signal;
        return new Promise((resolve) => { finish = resolve; });
      },
    });
    context.append({ role: "user", content: "old" });
    const before = context.messagesForModel();

    const compacting = context.compact(controller.signal);
    await Promise.resolve();
    controller.abort(new Error("stop compacting"));

    await expect(compacting).rejects.toThrow("stop compacting");
    expect(receivedSignal?.aborted).toBe(true);
    finish("late summary");
    await Promise.resolve();
    expect(context.messagesForModel()).toEqual(before);
  });

  it("leaves context unchanged when PostCompact fails", async () => {
    const hooks = new HookBus();
    hooks.on("PostCompact", () => { throw new Error("post failed"); });
    const context = createContext({ hooks, compactAtChars: 1, recentTurns: 0 });
    context.append({ role: "user", content: "old" });
    const before = context.messagesForModel();

    await expect(context.compact()).rejects.toThrow("post failed");

    expect(context.messagesForModel()).toEqual(before);
  });

  it("does not start summarization after PreCompact is externally aborted", async () => {
    const hooks = new HookBus();
    hooks.on("PreCompact", async (_event, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }), { failurePolicy: "allow" });
    const controller = new AbortController();
    let summarizeCalled = false;
    const context = createContext({
      hooks,
      compactAtChars: 1,
      recentTurns: 0,
      summarize: async () => { summarizeCalled = true; return "summary"; },
    });
    context.append({ role: "user", content: "old" });

    const compacting = context.compact(controller.signal);
    queueMicrotask(() => controller.abort(new Error("pre aborted")));

    await expect(compacting).rejects.toThrow("pre aborted");
    expect(summarizeCalled).toBe(false);
  });

  it("stops hook dispatch immediately when external cancellation interrupts PreCompact", async () => {
    const hooks = new HookBus();
    let secondCalled = false;
    hooks.on("PreCompact", async (_event, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }), { failurePolicy: "allow" });
    hooks.on("PreCompact", async () => {
      secondCalled = true;
      return new Promise(() => undefined);
    });
    const controller = new AbortController();
    const context = createContext({ hooks, compactAtChars: 1, recentTurns: 0 });
    context.append({ role: "user", content: "old" });
    const before = context.messagesForModel();

    const compacting = context.compact(controller.signal);
    queueMicrotask(() => controller.abort(new Error("dispatch cancelled")));

    await expect(compacting).rejects.toThrow("dispatch cancelled");
    expect(secondCalled).toBe(false);
    expect(context.messagesForModel()).toEqual(before);
  });
});

function createContext(overrides: Partial<ConstructorParameters<typeof ContextManager>[0]> = {}) {
  return new ContextManager({
    system: "system instructions",
    flavor: "project guidance",
    taskState: "in progress",
    compactAtChars: 1_000,
    toolOutputChars: 100,
    recentTurns: 2,
    summarize: async () => "summary",
    hooks: new HookBus(),
    ...overrides,
  });
}
