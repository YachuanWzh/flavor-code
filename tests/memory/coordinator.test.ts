import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MemoryCoordinator } from "../../src/memory/coordinator.js";
import { MemoryStore } from "../../src/memory/store.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function fixture(generate: (prompt: string, signal: AbortSignal) => Promise<string>, minChars = 1) {
  const workspace = await mkdtemp(join(tmpdir(), "flavor-memory-coordinator-")); roots.push(workspace);
  const store = new MemoryStore({ workspace, maxEntries: 20, maxEntryChars: 200 });
  return { store, coordinator: new MemoryCoordinator({ store, generate, minChars, maxEntryChars: 200 }) };
}

describe("MemoryCoordinator", () => {
  it("queues extraction, writes parsed candidates, and flushes deterministically", async () => {
    const generate = vi.fn(async (_prompt: string, _signal: AbortSignal) =>
      '{"memories":[{"type":"project","content":"Use pnpm."}]}');
    const { store, coordinator } = await fixture(generate);

    expect(coordinator.enqueue([
      { role: "user", content: "Remember the package manager." },
      { role: "assistant", content: "The project uses pnpm." },
    ])).toBe(true);
    await coordinator.flush();

    expect(generate).toHaveBeenCalledOnce();
    expect(generate.mock.calls[0]?.[0]).toContain("project uses pnpm");
    expect(await store.list()).toMatchObject([{ type: "project", content: "Use pnpm." }]);
  });

  it("skips short turns and isolates a failed extraction from later work", async () => {
    const failures: string[] = [];
    let call = 0;
    const { store, coordinator } = await fixture(async () => {
      call += 1;
      if (call === 1) throw new Error("provider offline");
      return '{"memories":[{"type":"feedback","content":"Do not commit automatically."}]}';
    }, 20);
    coordinator.onError = (error) => failures.push(error instanceof Error ? error.message : String(error));

    expect(coordinator.enqueue([{ role: "user", content: "short" }])).toBe(false);
    expect(coordinator.enqueue([{ role: "user", content: "This turn is long enough to fail once." }])).toBe(true);
    expect(coordinator.enqueue([{ role: "user", content: "This later turn must still be processed." }])).toBe(true);
    await coordinator.flush();

    expect(failures).toEqual(["provider offline"]);
    expect(await store.list()).toMatchObject([{ type: "feedback", content: "Do not commit automatically." }]);
  });
});
