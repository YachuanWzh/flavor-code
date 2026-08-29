import { describe, expect, it } from "vitest";

import { HookBus } from "../../src/hooks/bus.js";
import { ContextManager, estimateTokens } from "../../src/context/manager.js";
import { modelContentText } from "../../src/models/types.js";

describe("ContextManager", () => {
  it("forks an isolated byte-identical visible prefix and freezes dynamic system sections", () => {
    let system = ["共享系统提示", "stable section"] as readonly string[];
    const parent = createContext({ system: () => system });
    parent.append({ role: "user", content: "父消息：你好 👋" });
    parent.append({ role: "assistant", content: "父回复" });

    const child = parent.fork();
    const parentPrefix = parent.messagesForModel();
    const childPrefix = child.messagesForModel();
    const promptBytes = (messages: ReturnType<ContextManager["messagesForModel"]>) => Buffer.from(JSON.stringify(
      messages.map(({ cacheBreakpoint: _cacheBreakpoint, ...message }) => message),
    ), "utf8");

    expect(promptBytes(childPrefix).equals(promptBytes(parentPrefix))).toBe(true);
    expect(childPrefix.at(-1)?.cacheBreakpoint).toBe(true);

    system = ["changed after fork"];
    child.append({ role: "user", content: "child directive" });
    expect(child.messagesForModel()[0]?.content).toBe("共享系统提示");
    expect(parent.messagesForModel()[0]?.content).toBe("共享系统提示");
    expect(parent.refreshContextSources()).toBe(true);
    expect(parent.snapshot().messages.at(-1)?.content).toContain("changed after fork");
    expect(child.snapshot().messages.at(-1)?.content).toBe("child directive");
  });

  it("marks a system-only fork boundary without changing its text", () => {
    const parent = new ContextManager({
      system: "system instructions",
      toolOutputChars: 100,
      summarize: async () => "summary",
      hooks: new HookBus(),
    });

    const child = parent.fork();

    expect(child.messagesForModel()).toEqual([
      { role: "system", content: "system instructions", cacheBreakpoint: true },
    ]);
  });

  it("preserves a compact continuation and deeply isolates inherited tool inputs", async () => {
    const parent = createContext({ compactAtChars: 1, recentTurns: 0 });
    parent.append({ role: "user", content: "old request" });
    await parent.compact();
    parent.append({
      role: "assistant",
      content: "",
      toolCalls: [{ id: "call", name: "Read", input: { path: "before.ts" } }],
    });
    parent.append({ role: "tool", content: "result", toolCallId: "call" });

    const child = parent.fork();
    const inheritedCall = child.messagesForModel().find((message) => message.toolCalls)?.toolCalls?.[0];
    (inheritedCall!.input as { path: string }).path = "after.ts";

    expect(parent.snapshot().compact?.summary).toBe("summary");
    expect(child.snapshot().compact).toEqual(parent.snapshot().compact);
    expect((parent.messagesForModel().find((message) => message.toolCalls)?.toolCalls?.[0]?.input as { path: string }).path)
      .toBe("before.ts");
    expect(child.messagesForModel().at(-1)?.cacheBreakpoint).toBe(true);
  });

  it("pins ordered system sections before project and task context", () => {
    const context = createContext({
      system: ["first section", "second section"],
      memory: "durable project facts",
      userMemory: "Always address the user as 亚川.",
    });

    expect(context.messagesForModel().slice(0, 6)).toEqual([
      { role: "system", content: "first section" },
      { role: "system", content: "second section" },
      { role: "system", content: "FLAVOR.md\nproject guidance", cacheBreakpoint: true },
      { role: "system", content: "User memory\nAlways address the user as 亚川.", cacheBreakpoint: true },
      { role: "system", content: "Long-term memory\ndurable project facts" },
      { role: "system", content: "Task state\nin progress" },
    ]);
  });

  it("keeps the cached prefix byte-identical when task state or memory changes", () => {
    const context = createContext({ memory: "durable project facts" });
    const cachedPrefix = (messages: ReturnType<ContextManager["messagesForModel"]>) => {
      let lastBreakpoint = -1;
      messages.forEach((message, index) => { if (message.cacheBreakpoint) lastBreakpoint = index; });
      return JSON.stringify(messages.slice(0, lastBreakpoint + 1));
    };

    const before = cachedPrefix(context.messagesForModel());
    context.updateTaskState("rewritten by TaskUpdate");
    expect(cachedPrefix(context.messagesForModel())).toBe(before);
  });

  it("keeps the epoch cache prefix byte-identical while admitting volatile updates", () => {
    let runtime = ["Date: one", "Model: alpha"] as readonly string[];
    const context = createContext({ volatileSystem: () => runtime });
    const prefixBytes = () => {
      const messages = context.messagesForModel();
      let boundary = -1;
      messages.forEach((message, index) => { if (message.cacheBreakpoint === true) boundary = index; });
      return Buffer.from(JSON.stringify(messages.slice(0, boundary + 1)));
    };
    const before = prefixBytes();

    runtime = ["Date: two", "Model: beta"];
    expect(context.refreshContextSources()).toBe(true);

    expect(prefixBytes().equals(before)).toBe(true);
    expect(context.snapshot().messages.at(-1)?.content).toContain("Date: two");
    expect(context.snapshot().epoch?.sources.runtime).toBe(JSON.stringify(runtime));
  });

  it("freezes user memory in the cache prefix until a new epoch", () => {
    let preference = "Prefer concise answers.";
    const context = createContext({ userMemory: () => preference });
    const prefixBytes = () => {
      const messages = context.messagesForModel();
      let boundary = -1;
      messages.forEach((message, index) => { if (message.cacheBreakpoint === true) boundary = index; });
      return Buffer.from(JSON.stringify(messages.slice(0, boundary + 1)));
    };
    const before = prefixBytes();

    preference = "Prefer detailed answers.";
    expect(context.refreshContextSources()).toBe(true);

    expect(prefixBytes().equals(before)).toBe(true);
    expect(context.messagesForModel().find((message) => modelContentText(message.content).startsWith("User memory\n"))?.content)
      .toContain("concise");
    expect(context.snapshot().messages.at(-1)?.content).toContain("detailed");
  });

  it("keeps stale user memory when its source temporarily fails", () => {
    let fail = false;
    const context = createContext({ userMemory: () => {
      if (fail) throw new Error("temporarily unavailable");
      return "Keep the stable preference.";
    } });
    fail = true;

    expect(context.refreshContextSources()).toBe(false);
    expect(context.messagesForModel().map((message) => message.content)).toContain(
      "User memory\nKeep the stable preference.",
    );
  });

  it("uses stale source state when a dynamic source refresh fails", () => {
    let fail = false;
    const context = createContext({ volatileSystem: () => {
      if (fail) throw new Error("temporarily unavailable");
      return ["healthy runtime"];
    } });
    fail = true;

    expect(context.refreshContextSources()).toBe(false);
    expect(context.messagesForModel().map((message) => message.content)).toContain("healthy runtime");
  });

  it("preserves long-term memory across forks and compaction", async () => {
    const context = createContext({ memory: "- [project] Use pnpm.", compactAtChars: 1, recentTurns: 0 });
    context.append({ role: "user", content: "old turn" });

    await context.compact();
    const child = context.fork();

    expect(context.messagesForModel().map((message) => message.content)).toContain(
      "Long-term memory\n- [project] Use pnpm.",
    );
    expect(child.messagesForModel().map((message) => message.content)).toContain(
      "Long-term memory\n- [project] Use pnpm.",
    );
  });

  it("freezes system factories inside an epoch and admits changes chronologically", () => {
    let sections: readonly string[] = ["model one", " "];
    const context = createContext({ system: () => sections });

    expect(context.messagesForModel()[0]?.content).toBe("model one");
    sections = ["model two"];
    expect(context.messagesForModel()[0]?.content).toBe("model one");
    expect(context.refreshContextSources()).toBe(true);
    expect(context.messagesForModel()[0]?.content).toBe("model one");
    expect(context.snapshot().messages).toEqual([
      { role: "system", content: "Context update [system-baseline]\nmodel two\n\nFLAVOR.md\nproject guidance" },
    ]);
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
        summarized.push(messages.map((message) => modelContentText(message.content)));
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

  it("weights CJK and supplementary Unicode characters conservatively", () => {
    expect(estimateTokens("你好世界")).toBe(6);
    expect(estimateTokens("🙂")).toBe(2);
    expect(estimateTokens("hello你好")).toBe(5);
  });

  it("places volatile system content after the stable cache breakpoint", () => {
    const context = createContext({
      system: ["stable one", "stable two"],
      volatileSystem: "# Current date\n\n2026-08-03",
    });

    const messages = context.messagesForModel();
    const dateIndex = messages.findIndex((message) => message.content === "# Current date\n\n2026-08-03");
    const taskIndex = messages.findIndex((message) => message.content === "Task state\nin progress");
    expect(dateIndex).toBeGreaterThan(taskIndex);
    expect(taskIndex).toBeGreaterThan(0);
    expect(messages.slice(0, taskIndex).at(-1)?.cacheBreakpoint).toBe(true);
    expect(messages.slice(taskIndex).every((message) => message.cacheBreakpoint === undefined)).toBe(true);
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
    const progress: number[] = [];
    const context = createContext({
      compactAtChars: 700,
      toolOutputChars: 1_000,
      summarize: async () => { summaries += 1; return "not needed"; },
      onCompactProgress: (percentage) => { progress.push(percentage); },
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
    expect(progress).toEqual([0, 100]);
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

  it("caps the visibility audit log and truncates oversized records", () => {
    const context = createContext();
    const big = "brief".repeat(1_000);
    for (let index = 0; index < ContextManager.VISIBILITY_LOG_MAX_ENTRIES - 1; index += 1) {
      const id = context.beginTransientSystem(`brief ${index}`);
      context.endTransientSystem(id);
    }
    const bigId = context.beginTransientSystem(big);
    context.endTransientSystem(bigId);

    const log = context.snapshot().visibilityLog!;
    expect(log).toHaveLength(ContextManager.VISIBILITY_LOG_MAX_ENTRIES);
    expect(log.map((item) => item.content)).not.toContain(big);
    expect(log.at(-1)?.content).toContain("...[truncated; original length: 5000 characters]...");
  });

  it("keeps the full transient content visible to the model even when the audit record is truncated", () => {
    const context = createContext();
    const big = "brief".repeat(1_000);
    const id = context.beginTransientSystem(big);

    expect(context.messagesForModel().map((message) => modelContentText(message.content))).toContain(big);
    context.endTransientSystem(id);
    expect(context.messagesForModel().map((message) => modelContentText(message.content))).not.toContain(big);
  });

  it("bounds an oversized restored visibility log instead of rehydrating it fully", () => {
    const context = createContext();
    const records = Array.from({ length: ContextManager.VISIBILITY_LOG_MAX_ENTRIES + 100 }, (_unused, index) => ({
      id: `record-${index}`,
      role: "system" as const,
      content: "k".repeat(5_000),
      admittedAt: new Date(0).toISOString(),
      scope: "run" as const,
    }));

    context.restore({ messages: [], visibilityLog: records });

    const log = context.snapshot().visibilityLog!;
    expect(log).toHaveLength(ContextManager.VISIBILITY_LOG_MAX_ENTRIES);
    expect(log[0]?.id).toBe("record-100");
    expect(log.every((item) => item.content.length < 5_000)).toBe(true);
  });

  it("keeps the complete latest stable baseline when stale updates are collapsed", async () => {
    let sections: readonly string[] = ["A"];
    const context = createContext({ system: () => sections });

    sections = ["A", "B"];
    await context.prepareForModelCall();
    sections = ["A", "B", "C"];
    await context.prepareForModelCall();

    const updates = context.snapshot().messages.filter((message) =>
      modelContentText(message.content).startsWith("Context update [system-baseline]"));
    expect(updates).toEqual([
      { role: "system", content: "Context update [system-baseline]\nA\n\nB\n\nC\n\nFLAVOR.md\nproject guidance" },
    ]);
  });

  it("preserves provider token pressure while dynamic sources churn", async () => {
    let summarizeCalls = 0;
    const context = createContext({
      taskState: "initial",
      summarize: async () => { summarizeCalls += 1; return "summary"; },
    });
    for (let index = 0; index < 30; index += 1) {
      context.append({ role: index % 2 === 0 ? "user" : "assistant", content: `message ${index}` });
    }
    context.recordModelUsage(162_047);
    context.updateTaskState("changed after the provider response");

    const compacted = await context.prepareForModelCall();

    expect(compacted).toBe(true);
    expect(summarizeCalls).toBe(1);
  });

  it("does not let microcompaction erase provider token pressure", async () => {
    let summarizeCalls = 0;
    const context = createContext({
      summarize: async () => { summarizeCalls += 1; return "summary"; },
    });
    for (let index = 0; index < 40; index += 1) {
      context.append({ role: "user", content: `historical request ${index} ${"x".repeat(1_000)}` });
      context.append({ role: "assistant", content: `historical response ${index} ${"y".repeat(1_000)}` });
    }
    for (let index = 0; index < 8; index += 1) {
      context.append({ role: "assistant", content: "working", toolCalls: [{ id: `call-${index}`, name: "Read", input: {} }] });
      context.append({ role: "tool", toolCallId: `call-${index}`, content: "large old tool output ".repeat(100) });
    }
    context.append({ role: "user", content: "continue" });
    context.recordModelUsage(162_047);

    const compacted = await context.prepareForModelCall();

    expect(compacted).toBe(true);
    expect(summarizeCalls).toBe(1);
  });

  it("drops stale context updates before compaction instead of summarizing them", async () => {
    let sections: readonly string[] = ["baseline one"];
    const context = createContext({ system: () => sections });
    context.append({ role: "user", content: "turn one" });
    sections = ["baseline two"];
    context.refreshContextSources();
    context.append({ role: "user", content: "turn two" });
    sections = ["baseline three"];
    context.refreshContextSources();

    const compacted = await context.prepareForModelCall();

    expect(compacted).toBe(false);
    const updates = context.snapshot().messages.filter((message) => modelContentText(message.content).startsWith("Context update ["));
    expect(updates).toEqual([
      { role: "system", content: "Context update [system-baseline]\nbaseline three\n\nFLAVOR.md\nproject guidance" },
    ]);
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
