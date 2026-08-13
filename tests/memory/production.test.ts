import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createProductionRuntime } from "../../src/production.js";
import { MemoryStore } from "../../src/memory/store.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  delete (globalThis as { __flavorMemoryRequests?: unknown }).__flavorMemoryRequests;
});

async function workspace(memory: Record<string, unknown>, config: Record<string, unknown> = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "flavor-memory-production-")); roots.push(root);
  const pluginRoot = join(root, ".flavor", "plugins", "memory-model");
  await mkdir(pluginRoot, { recursive: true });
  await writeFile(join(root, ".flavor", "flavor.json"), JSON.stringify({
    providers: { capture: { type: "plugin", defaultModel: "main", cheapModel: "child" } },
    agents: { main: { model: "capture:main" }, subagent: { model: "capture:child" } },
    // Keep production tests deterministic: disable the review auto-dismiss timer
    // unless a specific test opts into it by passing reviewAutoDismissSeconds.
    memory: { reviewAutoDismissSeconds: 0, ...memory },
    ...config,
  }));
  await writeFile(join(pluginRoot, "flavor-plugin.json"), JSON.stringify({
    name: "memory-model", version: "1.0.0", apiVersion: "1", main: "index.mjs", permissions: [],
    contributes: { commands: [], tools: [], hooks: [], skillRoots: [], modelAdapters: [{ name: "capture" }] },
  }));
  await writeFile(join(pluginRoot, "index.mjs"), `export function activate(ctx) {
    ctx.registerModelAdapter("capture", { async *stream(request) {
      globalThis.__flavorMemoryRequests ??= [];
      globalThis.__flavorMemoryRequests.push(request.messages);
      const text = request.messages.map((message) => message.content).join("\\n");
      if (text.includes("Evaluate this completed coding task")) {
        const memories = text.includes("NO_MEMORY") ? [] : text.includes("HIGH_SCORE") ? [
          {"type":"project","summary":"Use pnpm for repository scripts","content":"Use pnpm for all repository scripts.","topicKey":"project.package-manager","keywords":["pnpm","scripts"],"scores":{"durability":3,"futureUtility":3,"authority":3,"nonDerivability":3}}
        ] : text.includes("zh-CN") ? [
          {"type":"project","summary":"仓库脚本使用 pnpm","content":"本项目的所有仓库脚本统一使用 pnpm。","topicKey":"project.package-manager","keywords":["pnpm","仓库脚本"],"scores":{"durability":3,"futureUtility":3,"authority":3,"nonDerivability":1}},
          {"type":"feedback","summary":"回答保持简洁","content":"回答用户时保持简洁。","topicKey":"user.response-style","keywords":["简洁"],"scores":{"durability":3,"futureUtility":3,"authority":3,"nonDerivability":1}}
        ] : [
          {"type":"project","summary":"Use pnpm for repository scripts","content":"Use pnpm for all repository scripts.","topicKey":"project.package-manager","keywords":["pnpm","scripts","package manager"],"scores":{"durability":3,"futureUtility":3,"authority":3,"nonDerivability":1}},
          {"type":"feedback","summary":"Keep answers concise","content":"Keep answers concise for the user.","topicKey":"user.response-style","keywords":["concise"],"scores":{"durability":3,"futureUtility":3,"authority":3,"nonDerivability":1}}
        ];
        yield { type: "text", text: JSON.stringify({ memories }) };
      } else if (text.includes("FAIL_MAIN")) {
        yield { type: "error", error: { code: "authentication", message: "simulated main-model failure" } };
        return;
      } else {
        yield { type: "text", text: "Acknowledged. This response is deliberately long enough to qualify for automatic durable memory extraction." };
      }
      yield { type: "done", usage: { inputTokens: 10, outputTokens: 5 } };
    }});
  }`);
  return root;
}

describe("production long-term memory", () => {
  it("directly analyzes and stores an explicit remember request without waiting for task finish", async () => {
    const root = await workspace({ autoExtract: true });
    const notices: string[] = [];
    const runtime = await createProductionRuntime({
      workspace: root, home: root, environment: {},
      output: (event) => { if (event.type === "notice") notices.push(event.message); },
    });

    await runtime.session.submit("请帮我记住：仓库脚本统一使用 pnpm。");

    const store = new MemoryStore({ workspace: root, maxEntries: 200, maxEntryChars: 1000 });
    expect(await store.list()).toMatchObject([{ type: "project", content: "Use pnpm for repository scripts" }]);
    expect(runtime.memoryReviews.pending).toEqual([]);
    expect(notices).toContain("Stored 1 explicit long-term-memory entry.");
    const requests = (globalThis as { __flavorMemoryRequests?: Array<Array<{ content: string }>> })
      .__flavorMemoryRequests ?? [];
    expect(requests.some((messages) => messages.some((message) => message.content.includes("explicitly asked")))).toBe(true);
    await runtime.dispose();
  });

  it("injects pre-existing memory into a fresh independent session", async () => {
    const root = await workspace({ autoExtract: false });
    const store = new MemoryStore({ workspace: root, maxEntries: 200, maxEntryChars: 1000 });
    await store.remember({ type: "feedback", content: "Do not commit automatically." });
    const runtime = await createProductionRuntime({ workspace: root, home: root, environment: {}, output: () => {} });

    await runtime.session.submit("Should I commit these changes automatically?");

    const requests = (globalThis as { __flavorMemoryRequests?: Array<Array<{ role: string; content: string }>> })
      .__flavorMemoryRequests ?? [];
    const main = requests.find((messages) => messages.some((message) => message.content.includes("Should I commit")));
    expect(main?.some((message) => message.role === "system"
      && message.content.includes("Do not commit automatically."))).toBe(true);
    await runtime.dispose();
  });

  it("always injects full user memory as the final cacheable system section", async () => {
    const root = await workspace({ autoExtract: false });
    const store = new MemoryStore({ workspace: root, maxEntries: 200, maxEntryChars: 1000 });
    await store.rememberForTask("user-profile", {
      type: "user", summary: "Address preference", content: "Always address the user as 亚川 in every response.",
      topicKey: "user.address", keywords: ["亚川", "address"],
      scores: { durability: 3, futureUtility: 3, authority: 3, nonDerivability: 3 },
    });
    const runtime = await createProductionRuntime({ workspace: root, home: root, environment: {}, output: () => {} });

    await runtime.session.submit("What is the weather like?");

    const requests = (globalThis as { __flavorMemoryRequests?: Array<Array<{ role: string; content: string; cacheBreakpoint?: boolean }>> })
      .__flavorMemoryRequests ?? [];
    const main = requests.find((messages) => messages.some((message) => message.content === "What is the weather like?"));
    const system = main?.filter((message) => message.role === "system") ?? [];
    expect(system.find((message) => message.cacheBreakpoint)).toEqual({
      role: "system",
      content: expect.stringContaining("Always address the user as 亚川 in every response."),
      cacheBreakpoint: true,
    });
    expect(system.some((message) => message.content.startsWith("# Current date"))).toBe(true);
    expect(system.at(-1)?.content).toMatch(/^# Runtime environment/);
    expect((await store.references()).find((reference) => reference.type === "user")?.recallTotal).toBe(1);

    await runtime.services.remember("user", "Prefer concise answers.");
    await runtime.session.submit("Tell me something unrelated.");
    const latest = [...requests].reverse().find((messages) =>
      messages.some((message) => message.content === "Tell me something unrelated."));
    expect(latest?.filter((message) => message.role === "system")
      .find((message) => message.cacheBreakpoint)?.content)
      .toContain("Prefer concise answers.");
    expect((await store.references()).filter((reference) => reference.type === "user")
      .map((reference) => reference.recallTotal)).toEqual([1, 1]);

    await runtime.services.finishTask();
    await runtime.session.submit("Start a new task.");
    expect((await store.references()).filter((reference) => reference.type === "user")
      .map((reference) => reference.recallTotal)).toEqual([2, 2]);
    await runtime.dispose();
  });

  it("automatically stages memory after a successful task, remains idempotent with /finish, and writes only after confirmation", async () => {
    const root = await workspace({ autoExtract: true, autoExtractMinChars: 200 });
    const first = await createProductionRuntime({ workspace: root, home: root, environment: {}, output: () => {} });

    await first.session.submit(`Please remember our stable package-manager convention for future independent sessions. ${"This task has useful durable context. ".repeat(8)}`);

    const store = new MemoryStore({ workspace: root, maxEntries: 200, maxEntryChars: 1000 });
    expect(await store.list()).toEqual([]);
    expect(first.memoryReviews.pending).toHaveLength(1);
    expect(first.memoryReviews.pending).toMatchObject([{ type: "project", content: "Use pnpm for all repository scripts." }]);
    const extractionCount = ((globalThis as { __flavorMemoryRequests?: Array<Array<{ content: string }>> })
      .__flavorMemoryRequests ?? []).filter((messages) => messages.some((message) => message.content.includes("Evaluate this completed coding task"))).length;
    expect(extractionCount).toBe(1);
    await expect(first.services.finishTask()).resolves.toBe("Task was already completed and evaluated for long-term memory.");
    expect(((globalThis as { __flavorMemoryRequests?: Array<Array<{ content: string }>> })
      .__flavorMemoryRequests ?? []).filter((messages) => messages.some((message) => message.content.includes("Evaluate this completed coding task")))).toHaveLength(extractionCount);
    await first.memoryReviews.accept(first.memoryReviews.pending[0]!.id);
    await first.dispose();

    const stored = await store.list();
    expect(stored).toMatchObject([{ type: "project", content: "Use pnpm for repository scripts" }]);

    const second = await createProductionRuntime({ workspace: root, home: root, environment: {}, output: () => {} });
    await second.session.submit("Which package manager should repository scripts use?");
    const requests = (globalThis as { __flavorMemoryRequests?: Array<Array<{ role: string; content: string }>> })
      .__flavorMemoryRequests ?? [];
    const latestMain = [...requests].reverse().find((messages) => messages.some((message) => message.content === "Which package manager should repository scripts use?"));
    expect(latestMain?.some((message) => message.role === "system"
      && message.content.includes("Use pnpm for all repository scripts."))).toBe(true);
    await second.dispose();
  });

  it("does not run automatic memory extraction for internal D2C artifact-generation prompts", async () => {
    const root = await workspace({ autoExtract: true, autoExtractMinChars: 200 });
    const runtime = await createProductionRuntime({ workspace: root, home: root, environment: {}, output: () => {} });
    runtime.authorization.setPermissionProfile("d2c");

    await runtime.session.submit(`Generate an internal E2E PRD artifact. ${"Large generated document context. ".repeat(12)}`);

    const requests = (globalThis as { __flavorMemoryRequests?: Array<Array<{ content: string }>> })
      .__flavorMemoryRequests ?? [];
    expect(requests.some((messages) => messages.some((message) =>
      message.content.includes("Evaluate this completed coding task")))).toBe(false);
    expect(runtime.memoryReviews.pending).toEqual([]);
    await runtime.dispose();
  });

  it("uses the configured language for generated memory fields", async () => {
    const root = await workspace({ autoExtract: true }, { language: "zh-CN" });
    const runtime = await createProductionRuntime({ workspace: root, home: root, environment: {}, output: () => {} });

    await runtime.session.submit(`Record the durable package-manager convention. ${"Useful task context. ".repeat(12)}`);

    expect(runtime.memoryReviews.pending).toEqual([
      expect.objectContaining({ type: "project", content: "本项目的所有仓库脚本统一使用 pnpm。", summary: "仓库脚本使用 pnpm" }),
    ]);
    const requests = (globalThis as { __flavorMemoryRequests?: Array<Array<{ content: string }>> })
      .__flavorMemoryRequests ?? [];
    expect(requests.some((messages) => messages.some((message) => message.content.includes("zh-CN")))).toBe(true);
    await runtime.dispose();
  });

  it("invalidates and hides pending reviews when the user sends a new query", async () => {
    const root = await workspace({ autoExtract: true });
    const runtime = await createProductionRuntime({ workspace: root, home: root, environment: {}, output: () => {} });
    await runtime.session.submit(`First durable task. ${"Useful durable context. ".repeat(12)}`);
    const oldReview = runtime.memoryReviews.pending[0]!;

    await runtime.session.submit(`NO_MEMORY New unrelated query. ${"Transient context. ".repeat(12)}`);

    expect(runtime.memoryReviews.pending).toEqual([]);
    await expect(runtime.memoryReviews.accept(oldReview.id)).resolves.toBe(false);
    await runtime.dispose();
  });

  it("does not auto-extract when the normal task fails", async () => {
    const root = await workspace({ autoExtract: true, autoExtractMinChars: 200 });
    const runtime = await createProductionRuntime({ workspace: root, home: root, environment: {}, output: () => {} });

    await runtime.session.submit(`FAIL_MAIN ${"durable-looking context ".repeat(20)}`);

    const requests = (globalThis as { __flavorMemoryRequests?: Array<Array<{ content: string }>> })
      .__flavorMemoryRequests ?? [];
    expect(requests.some((messages) => messages.some((message) => message.content.includes("Evaluate this completed coding task")))).toBe(false);
    expect(runtime.memoryReviews.pending).toEqual([]);
    await runtime.dispose();
  });

  it("evaluates only the current task when multiple tasks share one session", async () => {
    const root = await workspace({ autoExtract: true, autoExtractMinChars: 200 });
    const runtime = await createProductionRuntime({ workspace: root, home: root, environment: {}, output: () => {} });

    await runtime.session.submit(`FIRST_TASK_MARKER ${"first durable task context ".repeat(10)}`);
    await runtime.services.finishTask();
    await runtime.session.submit(`SECOND_TASK_MARKER ${"second durable task context ".repeat(10)}`);
    await runtime.services.finishTask();

    const extractions = ((globalThis as { __flavorMemoryRequests?: Array<Array<{ content: string }>> })
      .__flavorMemoryRequests ?? []).filter((messages) => messages.some((message) => message.content.includes("Evaluate this completed coding task")));
    expect(extractions).toHaveLength(2);
    const secondPrompt = extractions[1]!.map((message) => message.content).join("\n");
    expect(secondPrompt).toContain("SECOND_TASK_MARKER");
    expect(secondPrompt).not.toContain("FIRST_TASK_MARKER");
    await runtime.dispose();
  });

  it("does not read, inject, or extract memory when disabled", async () => {
    const root = await workspace({ enabled: false, autoExtract: true, autoExtractMinChars: 200 });
    const store = new MemoryStore({ workspace: root, maxEntries: 200, maxEntryChars: 1000 });
    await store.remember({ type: "project", content: "Invisible memory." });
    const runtime = await createProductionRuntime({ workspace: root, home: root, environment: {}, output: () => {} });

    await runtime.session.submit("A long prompt that would otherwise trigger automatic extraction immediately.");
    await runtime.session.close();

    const requests = (globalThis as { __flavorMemoryRequests?: Array<Array<{ role: string; content: string }>> })
      .__flavorMemoryRequests ?? [];
    expect(requests.some((messages) => messages.some((message) => message.content.includes("Invisible memory.")))).toBe(false);
    expect(requests.some((messages) => messages.some((message) => message.content.includes("Evaluate this completed coding task")))).toBe(false);
    await runtime.dispose();
  });

  it("does not auto-extract in non-interactive mode because no user can confirm the write", async () => {
    const root = await workspace({ autoExtract: true, autoExtractMinChars: 200 });
    const runtime = await createProductionRuntime({
      workspace: root, home: root, environment: {}, output: () => {}, approvalPolicy: "deny",
    });

    await runtime.session.submit("This is long enough to otherwise produce a durable memory candidate.");
    await runtime.session.close();

    const requests = (globalThis as { __flavorMemoryRequests?: Array<Array<{ role: string; content: string }>> })
      .__flavorMemoryRequests ?? [];
    expect(requests.some((messages) => messages.some((message) => message.content.includes("Evaluate this completed coding task")))).toBe(false);
    expect(runtime.memoryReviews.pending).toEqual([]);
    expect(await new MemoryStore({ workspace: root, maxEntries: 200, maxEntryChars: 1000 }).list()).toEqual([]);
    await runtime.dispose();
  });

  it("auto-stores high-confidence candidates and reports the direct write", async () => {
    const root = await workspace({ autoExtract: true, autoExtractMinChars: 200 });
    const notices: string[] = [];
    const runtime = await createProductionRuntime({
      workspace: root, home: root, environment: {},
      output: (event) => { if (event.type === "notice") notices.push(event.message); },
    });

    await runtime.session.submit(`HIGH_SCORE Remember our durable package-manager convention. ${"Useful durable context. ".repeat(12)}`);

    const store = new MemoryStore({ workspace: root, maxEntries: 200, maxEntryChars: 1000 });
    expect(await store.list()).toMatchObject([{ type: "project", content: "Use pnpm for repository scripts" }]);
    expect(runtime.memoryReviews.pending).toEqual([]);
    expect(notices.some((notice) => notice.includes("Stored high-confidence long-term memory directly"))).toBe(true);
    expect(notices.some((notice) => notice.includes("Use pnpm for all repository scripts."))).toBe(true);
    await runtime.dispose();
  });

  it("pauses automatic extraction after repeated dismissals and resumes after an explicit store", async () => {
    const root = await workspace({ autoExtract: true, autoExtractMinChars: 200, ignoreStreakLimit: 2 });
    const runtime = await createProductionRuntime({ workspace: root, home: root, environment: {}, output: () => {} });
    const extractions = () => ((globalThis as { __flavorMemoryRequests?: Array<Array<{ content: string }>> })
      .__flavorMemoryRequests ?? []).filter((messages) => messages.some((message) => message.content.includes("Evaluate this completed coding task")));

    await runtime.session.submit(`First durable task. ${"Useful durable context. ".repeat(12)}`);
    expect(runtime.memoryReviews.pending).toHaveLength(1);
    runtime.memoryReviews.dismiss(runtime.memoryReviews.pending[0]!.id);

    await runtime.session.submit(`Second durable task. ${"Useful durable context. ".repeat(12)}`);
    expect(runtime.memoryReviews.pending).toHaveLength(1);
    runtime.memoryReviews.dismiss(runtime.memoryReviews.pending[0]!.id);

    // Auto-extraction is paused: the third ordinary task is not evaluated at all.
    await runtime.session.submit(`Third durable task. ${"Useful durable context. ".repeat(12)}`);
    expect(runtime.memoryReviews.pending).toEqual([]);
    expect(extractions()).toHaveLength(2);

    // A manual /finish still works and bypasses the pause.
    await expect(runtime.services.finishTask()).resolves.toContain("Task completed.");
    expect(extractions()).toHaveLength(3);

    // An explicit remember request restores automatic extraction. It also calls
    // the shared extraction prompt once, so the count advances by one here.
    await runtime.session.submit("请帮我记住：仓库脚本统一使用 pnpm。");
    await runtime.session.submit(`Fourth durable task. ${"Useful durable context. ".repeat(12)}`);
    expect(runtime.memoryReviews.pending).toHaveLength(1);
    expect(extractions()).toHaveLength(5);
    await runtime.dispose();
  });
});
