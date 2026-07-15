import { describe, expect, it } from "vitest";

import { HookBus } from "../../src/hooks/bus.js";
import { ContextManager, estimateTokens } from "../../src/context/manager.js";

describe("ContextManager", () => {
  it("pins ordered system sections before project and task context", () => {
    const context = createContext({ system: ["first section", "second section"] });

    expect(context.messagesForModel().slice(0, 4)).toEqual([
      { role: "system", content: "first section" },
      { role: "system", content: "second section" },
      { role: "system", content: "FLAVOR.md\nproject guidance" },
      { role: "system", content: "Task state\nin progress" },
    ]);
  });

  it("resolves system section factories for every model request", () => {
    let sections: readonly string[] = ["model one", " "];
    const context = createContext({ system: () => sections });

    expect(context.messagesForModel()[0]?.content).toBe("model one");
    sections = ["model two"];
    expect(context.messagesForModel()[0]?.content).toBe("model two");
    expect(context.snapshot().messages).toEqual([]);
  });

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
      expect.stringContaining("continued from a previous conversation"),
      "recent question",
      "recent answer",
    ]);
    expect(context.messagesForModel()[3]?.role).toBe("user");
    expect(context.snapshot().compact).toMatchObject({ summary: "structured summary" });
  });

  it("reports full compaction milestones through completion", async () => {
    const progress: number[] = [];
    const context = createContext({
      compactAtChars: 1,
      recentTurns: 0,
      onCompactProgress: (percentage) => { progress.push(percentage); },
    });
    context.append({ role: "user", content: "old question" });

    await expect(context.compact()).resolves.toBe(true);

    expect(progress).toEqual([0, 10, 80, 90, 100]);
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

  it("uses the last provider input usage for automatic token pressure", async () => {
    const context = new ContextManager({
      system: "system",
      toolOutputChars: 100,
      compaction: {
        windowTokens: 30,
        reservedOutputTokens: 5,
        autoCompactBufferTokens: 5,
        warningBufferTokens: 5,
        blockingBufferTokens: 2,
        microcompactKeepRecentToolResults: 1,
        recentTokens: 1,
        recentTextMessages: 1,
        maxRecentTokens: 10,
      },
      summarize: async () => "summary from usage",
      hooks: new HookBus(),
    });
    context.append({ role: "user", content: "old" });
    context.append({ role: "assistant", content: "old reply" });
    context.append({ role: "user", content: "recent" });
    context.recordModelUsage(20);

    expect(context.lastRecordedInputTokens).toBe(20);
    expect(await context.prepareForModelCall()).toBe(true);
    expect(context.snapshot().compact?.summary).toBe("summary from usage");
  });

  it("adds newly appended context to the last provider input usage", () => {
    const context = new ContextManager({
      system: "system",
      toolOutputChars: 1_000,
      compaction: {
        windowTokens: 30,
        reservedOutputTokens: 5,
        autoCompactBufferTokens: 5,
        warningBufferTokens: 5,
        blockingBufferTokens: 2,
        microcompactKeepRecentToolResults: 1,
        recentTokens: 1,
        recentTextMessages: 1,
        maxRecentTokens: 10,
      },
      summarize: async () => "summary",
      hooks: new HookBus(),
    });
    context.append({ role: "user", content: "short" });
    context.recordModelUsage(15);
    context.append({ role: "assistant", content: "x".repeat(40) });

    expect(context.needsCompaction()).toBe(true);
  });

  it("microcompacts old tool results before paying for a full summary", async () => {
    let summaries = 0;
    const context = createContext({
      compactAtChars: 700,
      toolOutputChars: 1_000,
      summarize: async () => { summaries += 1; return "not needed"; },
      compaction: {
        microcompactKeepRecentToolResults: 1,
      },
    });
    context.append({ role: "assistant", content: "", toolCalls: [{ id: "old", name: "Read", input: {} }] });
    context.append({ role: "tool", content: "x".repeat(400), toolCallId: "old" });
    context.append({ role: "assistant", content: "", toolCalls: [{ id: "new", name: "Shell", input: {} }] });
    context.append({ role: "tool", content: "y".repeat(400), toolCallId: "new" });

    expect(await context.prepareForModelCall()).toBe(true);

    expect(summaries).toBe(0);
    expect(context.messagesForModel().find((message) => message.toolCallId === "old")?.content).toContain("cleared");
    expect(context.messagesForModel().find((message) => message.toolCallId === "new")?.content).toBe("y".repeat(400));
  });

  it("rolls back staged microcompaction when automatic full compaction fails", async () => {
    const context = createContext({
      compactAtChars: 1,
      toolOutputChars: 1_000,
      recentTurns: 0,
      compaction: { microcompactKeepRecentToolResults: 1 },
      summarize: async () => { throw new Error("summary failed"); },
    });
    context.append({ role: "assistant", content: "", toolCalls: [{ id: "old", name: "Read", input: {} }] });
    context.append({ role: "tool", content: "x".repeat(400), toolCallId: "old" });
    context.append({ role: "assistant", content: "", toolCalls: [{ id: "new", name: "Shell", input: {} }] });
    context.append({ role: "tool", content: "y".repeat(400), toolCallId: "new" });
    const before = context.messagesForModel();

    await expect(context.prepareForModelCall()).resolves.toBe(false);

    expect(context.messagesForModel()).toEqual(before);
  });

  it("rolls back staged microcompaction when PreCompact denies full compaction", async () => {
    const hooks = new HookBus();
    hooks.on("PreCompact", () => ({ decision: "deny", reason: "keep history" }));
    const context = createContext({
      hooks,
      compactAtChars: 1,
      toolOutputChars: 1_000,
      recentTurns: 0,
      compaction: { microcompactKeepRecentToolResults: 1 },
    });
    context.append({ role: "assistant", content: "", toolCalls: [{ id: "old", name: "Read", input: {} }] });
    context.append({ role: "tool", content: "x".repeat(400), toolCallId: "old" });
    context.append({ role: "assistant", content: "", toolCalls: [{ id: "new", name: "Shell", input: {} }] });
    context.append({ role: "tool", content: "y".repeat(400), toolCallId: "new" });
    const before = context.messagesForModel();

    await expect(context.prepareForModelCall()).resolves.toBe(false);

    expect(context.messagesForModel()).toEqual(before);
  });

  it("trips automatic compaction after three failures but still permits manual compact", async () => {
    let attempts = 0;
    const context = createContext({
      compactAtChars: 1,
      recentTurns: 0,
      summarize: async () => {
        attempts += 1;
        if (attempts <= 3) throw new Error("summary failed");
        return "manual recovery";
      },
    });
    context.append({ role: "user", content: "old" });

    await expect(context.prepareForModelCall()).resolves.toBe(false);
    await expect(context.prepareForModelCall()).resolves.toBe(false);
    await expect(context.prepareForModelCall()).resolves.toBe(false);
    await expect(context.prepareForModelCall()).resolves.toBe(false);
    expect(attempts).toBe(3);
    expect(context.consecutiveAutoCompactFailures).toBe(3);

    await expect(context.compact(undefined, "manual")).resolves.toBe(true);
    expect(attempts).toBe(4);
    expect(context.snapshot().compact?.summary).toBe("manual recovery");
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
