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

async function workspace(memory: Record<string, unknown>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "flavor-memory-production-")); roots.push(root);
  const pluginRoot = join(root, ".flavor", "plugins", "memory-model");
  await mkdir(pluginRoot, { recursive: true });
  await writeFile(join(root, ".flavor", "flavor.json"), JSON.stringify({
    providers: { capture: { type: "plugin", defaultModel: "main", cheapModel: "child" } },
    agents: { main: { model: "capture:main" }, subagent: { model: "capture:child" } },
    memory,
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
        yield { type: "text", text: '{"memories":[{"type":"project","summary":"Use pnpm for repository scripts","content":"Use pnpm for all repository scripts.","topicKey":"project.package-manager","keywords":["pnpm","scripts","package manager"],"scores":{"durability":3,"futureUtility":3,"authority":3,"nonDerivability":2}}]}' };
      } else {
        yield { type: "text", text: "Acknowledged. This response is deliberately long enough to qualify for automatic durable memory extraction." };
      }
      yield { type: "done", usage: { inputTokens: 10, outputTokens: 5 } };
    }});
  }`);
  return root;
}

describe("production long-term memory", () => {
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

  it("stages extracted memory, writes only after confirmation, and exposes it to the next runtime", async () => {
    const root = await workspace({ autoExtract: true, autoExtractMinChars: 200 });
    const first = await createProductionRuntime({ workspace: root, home: root, environment: {}, output: () => {} });

    await first.session.submit(`Please remember our stable package-manager convention for future independent sessions. ${"This task has useful durable context. ".repeat(8)}`);

    const store = new MemoryStore({ workspace: root, maxEntries: 200, maxEntryChars: 1000 });
    expect(await store.list()).toEqual([]);
    expect(first.memoryReviews.pending).toEqual([]);
    await first.services.finishTask();
    const extractionCount = ((globalThis as { __flavorMemoryRequests?: Array<Array<{ content: string }>> })
      .__flavorMemoryRequests ?? []).filter((messages) => messages.some((message) => message.content.includes("Evaluate this completed coding task"))).length;
    await first.services.finishTask();
    expect(((globalThis as { __flavorMemoryRequests?: Array<Array<{ content: string }>> })
      .__flavorMemoryRequests ?? []).filter((messages) => messages.some((message) => message.content.includes("Evaluate this completed coding task")))).toHaveLength(extractionCount);
    expect(first.memoryReviews.pending).toMatchObject([{ type: "project", content: "Use pnpm for all repository scripts." }]);
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
});
