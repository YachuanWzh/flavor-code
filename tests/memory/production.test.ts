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
      if (text.includes("Extract only durable facts")) {
        yield { type: "text", text: '{"memories":[{"type":"project","content":"Use pnpm for all repository scripts."}]}' };
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

    await runtime.session.submit("Inspect the workspace.");

    const requests = (globalThis as { __flavorMemoryRequests?: Array<Array<{ role: string; content: string }>> })
      .__flavorMemoryRequests ?? [];
    const main = requests.find((messages) => messages.some((message) => message.content.includes("Inspect the workspace")));
    expect(main?.some((message) => message.role === "system"
      && message.content.includes("Do not commit automatically."))).toBe(true);
    await runtime.dispose();
  });

  it("extracts after a completed turn, flushes on close, and exposes it to the next runtime", async () => {
    const root = await workspace({ autoExtract: true, autoExtractMinChars: 20 });
    const first = await createProductionRuntime({ workspace: root, home: root, environment: {}, output: () => {} });

    await first.session.submit("Please remember our stable package-manager convention for future independent sessions.");
    await first.session.close();
    await first.dispose();

    const stored = await new MemoryStore({ workspace: root, maxEntries: 200, maxEntryChars: 1000 }).list();
    expect(stored).toMatchObject([{ type: "project", content: "Use pnpm for all repository scripts." }]);

    const second = await createProductionRuntime({ workspace: root, home: root, environment: {}, output: () => {} });
    await second.session.submit("What should I inspect?");
    const requests = (globalThis as { __flavorMemoryRequests?: Array<Array<{ role: string; content: string }>> })
      .__flavorMemoryRequests ?? [];
    const latestMain = [...requests].reverse().find((messages) => messages.some((message) => message.content === "What should I inspect?"));
    expect(latestMain?.some((message) => message.role === "system"
      && message.content.includes("Use pnpm for all repository scripts."))).toBe(true);
    await second.dispose();
  });

  it("does not read, inject, or extract memory when disabled", async () => {
    const root = await workspace({ enabled: false, autoExtract: true, autoExtractMinChars: 1 });
    const store = new MemoryStore({ workspace: root, maxEntries: 200, maxEntryChars: 1000 });
    await store.remember({ type: "project", content: "Invisible memory." });
    const runtime = await createProductionRuntime({ workspace: root, home: root, environment: {}, output: () => {} });

    await runtime.session.submit("A long prompt that would otherwise trigger automatic extraction immediately.");
    await runtime.session.close();

    const requests = (globalThis as { __flavorMemoryRequests?: Array<Array<{ role: string; content: string }>> })
      .__flavorMemoryRequests ?? [];
    expect(requests.some((messages) => messages.some((message) => message.content.includes("Invisible memory.")))).toBe(false);
    expect(requests.some((messages) => messages.some((message) => message.content.includes("Extract only durable facts")))).toBe(false);
    await runtime.dispose();
  });
});
