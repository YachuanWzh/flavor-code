import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { MemoryStore, parseMemoryDocument, renderMemoryDocument } from "../../src/memory/store.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function store(options: { maxEntries?: number; maxEntryChars?: number } = {}): Promise<MemoryStore> {
  const workspace = await mkdtemp(join(tmpdir(), "flavor-memory-"));
  roots.push(workspace);
  return new MemoryStore({ workspace, maxEntries: 10, maxEntryChars: 200, ...options });
}

describe("MemoryStore", () => {
  it("round-trips the canonical human-editable Markdown format", () => {
    const entries = [
      { id: "ignored", type: "user" as const, content: "Prefers concise summaries." },
      { id: "ignored", type: "feedback" as const, content: "Do not commit automatically." },
      { id: "ignored", type: "project" as const, content: "Use pnpm for scripts." },
      { id: "ignored", type: "reference" as const, content: "Runbook is in the team wiki." },
    ];

    const rendered = renderMemoryDocument(entries);
    const parsed = parseMemoryDocument(rendered, 200);

    expect(rendered).toContain("# Flavor Project Memory");
    expect(rendered).toContain("## project\n- Use pnpm for scripts.");
    expect(parsed.map(({ type, content }) => ({ type, content }))).toEqual(
      entries.map(({ type, content }) => ({ type, content })),
    );
    expect(parsed.every((entry) => /^[a-f0-9]{12}$/.test(entry.id))).toBe(true);
  });

  it("stores accepted task memories as typed files referenced by a V2 routing index", async () => {
    const memory = await store();
    const result = await memory.rememberForTask("task-20260722", {
      type: "project", summary: "Use pnpm", content: "Use pnpm for repository scripts.",
      topicKey: "project.package-manager", keywords: ["pnpm", "scripts"],
      scores: { durability: 3, futureUtility: 3, authority: 3, nonDerivability: 2 },
    }, new Date("2026-07-22T00:00:00.000Z"));

    expect(result.added).toBe(true);
    const index = await readFile(memory.path, "utf8");
    expect(index).toContain("# Flavor Project Memory Index");
    expect(index).toContain("[project] Use pnpm");
    const task = await readFile(join(memory.workspace, ".flavor", "memory", "tasks", "task-20260722.md"), "utf8");
    expect(task).toContain("## project");
    expect(task).toContain("Use pnpm for repository scripts.");
    expect(await memory.list()).toEqual([expect.objectContaining({ type: "project", content: "Use pnpm" })]);
  });

  it("suppresses high-confidence duplicates and counts a recall once per task", async () => {
    const memory = await store();
    const candidate = {
      type: "project" as const, summary: "Use pnpm for scripts", content: "Use pnpm for repository scripts.",
      topicKey: "project.package-manager", keywords: ["pnpm", "scripts"],
      scores: { durability: 3, futureUtility: 3, authority: 3, nonDerivability: 2 },
    };
    expect((await memory.rememberForTask("task-one", candidate)).added).toBe(true);
    expect((await memory.rememberForTask("task-two", { ...candidate, content: "Use pnpm for all repository scripts." })).added).toBe(false);

    const first = await memory.recall("pnpm repository scripts", {
      taskId: "consumer-task", topK: 5, maxChars: 1_000, now: new Date("2026-07-22T00:00:00.000Z"),
    });
    const second = await memory.recall("pnpm repository scripts", {
      taskId: "consumer-task", topK: 5, maxChars: 1_000, now: new Date("2026-07-22T01:00:00.000Z"),
    });

    expect(first.context).toContain("Use pnpm for repository scripts.");
    expect(second.context).toContain("Use pnpm for repository scripts.");
    expect((await memory.references())[0]).toMatchObject({ recallTotal: 1, recalls: { "consumer-task": "2026-07-22T00:00:00.000Z" } });
  });

  it("normalizes, de-duplicates, bounds, and forgets entries by text or id", async () => {
    const memory = await store({ maxEntries: 2 });

    expect((await memory.remember({ type: "project", content: "  Use   pnpm\nfor scripts.  " })).added).toBe(true);
    expect((await memory.remember({ type: "project", content: "use pnpm for scripts." })).added).toBe(false);
    expect((await memory.remember({ type: "user", content: "Prefers Chinese responses." })).added).toBe(true);
    expect((await memory.remember({ type: "reference", content: "Ignored at capacity." })).added).toBe(false);

    const entries = await memory.list();
    expect(entries.map((entry) => entry.content).sort()).toEqual(["Prefers Chinese responses.", "Use pnpm for scripts."]);
    expect(await memory.forget(entries.find((entry) => entry.type === "project")!.id)).toBe(1);
    expect(await memory.forget("chinese")).toBe(1);
    expect(await memory.list()).toEqual([]);
  });

  it("updates and deletes one exact entry for management UIs", async () => {
    const memory = await store();
    const first = (await memory.remember({ type: "project", content: "Use npm." })).entry;
    const second = (await memory.remember({ type: "feedback", content: "Do not commit." })).entry;

    const updated = await memory.update(first.id, { type: "project", content: "Use pnpm." });

    expect(updated.id).not.toBe(first.id);
    expect(updated.content).toBe("Use pnpm.");
    expect(await memory.delete(second.id)).toBe(true);
    expect(await memory.delete(second.id)).toBe(false);
    expect(await memory.list()).toEqual([updated]);
  });

  it("rejects updates for missing entries or duplicate content", async () => {
    const memory = await store();
    const first = (await memory.remember({ type: "project", content: "Convention A" })).entry;
    await memory.remember({ type: "project", content: "Convention B" });

    await expect(memory.update("000000000000", { type: "project", content: "Missing" })).rejects.toThrow(/not found/i);
    await expect(memory.update(first.id, { type: "project", content: "convention b" })).rejects.toThrow(/already exists/i);
    expect((await memory.list()).map((entry) => entry.content)).toEqual(["Convention A", "Convention B"]);
  });

  it("rejects overlong and sensitive entries without changing the file", async () => {
    const memory = await store({ maxEntryChars: 30 });

    await expect(memory.remember({ type: "project", content: "x".repeat(31) })).rejects.toThrow(/30/);
    await expect(memory.remember({ type: "reference", content: "API_KEY=sk-secret-value-123456789" }))
      .rejects.toThrow(/sensitive/i);
    expect(await memory.list()).toEqual([]);
  });

  it("serializes concurrent updates so independent sessions do not lose entries", async () => {
    const first = await store();
    const second = new MemoryStore({ workspace: first.workspace, maxEntries: 10, maxEntryChars: 200 });

    await Promise.all([
      first.remember({ type: "project", content: "Convention A" }),
      second.remember({ type: "project", content: "Convention B" }),
    ]);

    expect((await first.list()).map((entry) => entry.content).sort()).toEqual(["Convention A", "Convention B"]);
    expect(await readFile(first.path, "utf8")).toContain("## References");
  });

  it("recovers a malformed primary file from the protected backup", async () => {
    const memory = await store();
    await memory.remember({ type: "project", content: "Keep this" });
    await memory.remember({ type: "user", content: "And this" });
    const backup = await readFile(`${memory.path}.bak`, "utf8");
    expect(backup).toContain("Keep this");
    await writeFile(memory.path, "not a memory document", "utf8");

    expect((await memory.list()).map((entry) => entry.content)).toEqual(["Keep this"]);
  });
});
