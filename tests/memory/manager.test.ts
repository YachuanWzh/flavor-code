import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { ProjectMemoryManager } from "../../src/memory/manager.js";
import { MemoryStore } from "../../src/memory/store.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function createStore(): Promise<MemoryStore> {
  const workspace = await mkdtemp(join(tmpdir(), "flavor-memory-manager-"));
  roots.push(workspace);
  return new MemoryStore({ workspace, maxEntries: 10, maxEntryChars: 200 });
}

describe("ProjectMemoryManager", () => {
  it("provides one CRUD surface for desktop and CLI", async () => {
    const manager = new ProjectMemoryManager(await createStore());
    const created = await manager.remember({ type: "project", content: "Use npm." });
    const updated = await manager.update(created.id, { type: "project", content: "Use pnpm." });

    expect((await manager.snapshot()).entries).toEqual([expect.objectContaining(updated)]);
    expect(await manager.delete(updated.id)).toBe(true);
    expect((await manager.snapshot()).entries).toEqual([]);
  });

  it("does not read or mutate the store when memory is disabled", async () => {
    const store = await createStore();
    await store.remember({ type: "project", content: "Hidden while disabled" });
    const manager = new ProjectMemoryManager(store, false);

    expect(await manager.snapshot()).toEqual({ enabled: false, path: store.path, entries: [] });
    await expect(manager.remember({ type: "project", content: "No write" })).rejects.toThrow(/disabled/i);
    await expect(manager.update("000000000000", { type: "project", content: "No update" })).rejects.toThrow(/disabled/i);
    await expect(manager.delete("000000000000")).rejects.toThrow(/disabled/i);
  });

  it("exposes recall heat and deletes all cold memories for the desktop workbench", async () => {
    const store = await createStore();
    await store.rememberForTask("old-task", {
      type: "project", summary: "Old rule", content: "Use the retired build script.",
      topicKey: "project.build", keywords: ["retired", "build"],
      scores: { durability: 3, futureUtility: 3, authority: 3, nonDerivability: 2 },
    }, new Date("2026-08-01T00:00:00.000Z"));
    const manager = new ProjectMemoryManager(store);

    const snapshot = await manager.snapshot(new Date("2026-08-10T00:00:00.000Z"));
    expect(snapshot.entries).toEqual([expect.objectContaining({ recallTotal: 0, heat: "cold" })]);
    await expect(manager.deleteCold(new Date("2026-08-10T00:00:00.000Z"))).resolves.toEqual({ removed: 1, filesRemoved: 1 });
    expect((await manager.snapshot()).entries).toEqual([]);
  });
});
