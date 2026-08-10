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

  it("returns every full user preference separately and counts its injection once per task", async () => {
    const memory = await store();
    await memory.rememberForTask("user-profile", {
      type: "user", summary: "Address preference", content: "Always address the user as 亚川.",
      topicKey: "user.address", keywords: ["亚川", "address"],
      scores: { durability: 3, futureUtility: 3, authority: 3, nonDerivability: 3 },
    });
    await memory.remember({ type: "user", content: "Use Chinese for every answer." });

    expect(await memory.userContext()).toContain("Always address the user as 亚川.");
    expect(await memory.userContext()).toContain("Use Chinese for every answer.");
    const recalled = await memory.recall("Always address the user as 亚川", {
      taskId: "consumer-task", topK: 5, maxChars: 1_000, now: new Date("2026-07-22T00:00:00.000Z"),
    });
    expect(recalled).toEqual({ references: [] });
    await memory.recall("An unrelated follow-up", {
      taskId: "consumer-task", topK: 5, maxChars: 1_000, now: new Date("2026-07-22T01:00:00.000Z"),
    });
    await memory.recall("A new task", {
      taskId: "another-task", topK: 5, maxChars: 1_000, now: new Date("2026-07-23T00:00:00.000Z"),
    });

    const references = await memory.references();
    expect(references.filter((reference) => reference.type === "user"))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ recallTotal: 2, recalls: {
          "consumer-task": "2026-07-22T00:00:00.000Z",
          "another-task": "2026-07-23T00:00:00.000Z",
        } }),
      ]));
    const index = await readFile(memory.path, "utf8");
    expect(index).toContain("  - updated:");
    expect(index).toContain("  - last-recalled: 2026-07-23T00:00:00.000Z");
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

  it("removes cold entries and their task files while keeping hot and normal entries", async () => {
    const memory = await store();
    const now = new Date("2026-08-10T12:00:00.000Z");
    const old = new Date("2026-08-01T12:00:00.000Z");
    const scores = { durability: 3, futureUtility: 3, authority: 3, nonDerivability: 2 };

    await memory.rememberForTask("task-cold", {
      type: "project", summary: "Old convention", content: "Use the legacy tool.",
      topicKey: "project.legacy", keywords: ["legacy"], scores,
    }, old);
    await memory.rememberForTask("task-normal", {
      type: "project", summary: "Fresh convention", content: "Use the current tool.",
      topicKey: "project.fresh", keywords: ["current"], scores,
    }, now);
    // 创建时间久远但 72 小时内被召回过的条目不视为 cold。
    await memory.rememberForTask("task-recently-recalled", {
      type: "reference", summary: "Docs link", content: "Team runbook lives in the wiki.",
      topicKey: "reference.runbook", keywords: ["runbook", "wiki"], scores,
    }, old);
    await memory.recall("runbook wiki", { taskId: "consumer-a", topK: 5, maxChars: 1_000, now: new Date("2026-08-10T10:00:00.000Z") });
    // 超过十个不同任务在滚动七天内召回过的条目不视为 cold。
    await memory.rememberForTask("task-hot", {
      type: "feedback", summary: "Review style", content: "Always review diffs before merging.",
      topicKey: "feedback.review", keywords: ["review", "diffs"], scores,
    }, old);
    for (let index = 0; index < 11; index += 1) {
      await memory.recall("review diffs merging", { taskId: `hot-consumer-${index}`, topK: 5, maxChars: 1_000, now: new Date("2026-08-10T11:00:00.000Z") });
    }

    const result = await memory.forgetCold(now);

    expect(result).toEqual({ removed: 1, filesRemoved: 1 });
    const references = await memory.references();
    expect(references.map((reference) => reference.taskId).sort()).toEqual(["task-hot", "task-normal", "task-recently-recalled"]);
    const taskRoot = join(memory.workspace, ".flavor", "memory", "tasks");
    await expect(readFile(join(taskRoot, "task-cold.md"), "utf8")).rejects.toThrow(/ENOENT/);
    await expect(readFile(`${join(taskRoot, "task-cold.md")}.bak`, "utf8")).rejects.toThrow(/ENOENT/);
    for (const taskId of ["task-normal", "task-recently-recalled", "task-hot"]) {
      await expect(readFile(join(taskRoot, `${taskId}.md`), "utf8")).resolves.toBeTruthy();
    }
  });

  it("removes only the cold entries from a shared task file", async () => {
    const memory = await store();
    const now = new Date("2026-08-10T12:00:00.000Z");
    const old = new Date("2026-08-01T12:00:00.000Z");
    const scores = { durability: 3, futureUtility: 3, authority: 3, nonDerivability: 2 };

    await memory.rememberForTask("task-shared", {
      type: "project", summary: "Old rule", content: "Use the legacy tool.",
      topicKey: "project.legacy", keywords: ["legacy"], scores,
    }, old);
    await memory.rememberForTask("task-shared", {
      type: "feedback", summary: "New rule", content: "Always verify builds.",
      topicKey: "feedback.verify", keywords: ["verify"], scores,
    }, now);

    const result = await memory.forgetCold(now);

    expect(result).toEqual({ removed: 1, filesRemoved: 0 });
    const taskFile = await readFile(join(memory.workspace, ".flavor", "memory", "tasks", "task-shared.md"), "utf8");
    expect(taskFile).not.toContain("Use the legacy tool.");
    expect(taskFile).toContain("Always verify builds.");
    expect((await memory.references()).map((reference) => reference.summary)).toEqual(["New rule"]);
  });

  it("reports zero and touches nothing when no entries are cold", async () => {
    const memory = await store();
    const now = new Date("2026-08-10T12:00:00.000Z");
    await memory.rememberForTask("task-fresh", {
      type: "project", summary: "Fresh convention", content: "Use the current tool.",
      topicKey: "project.fresh", keywords: ["current"],
      scores: { durability: 3, futureUtility: 3, authority: 3, nonDerivability: 2 },
    }, now);

    const result = await memory.forgetCold(now);

    expect(result).toEqual({ removed: 0, filesRemoved: 0 });
    expect((await memory.references()).map((reference) => reference.taskId)).toEqual(["task-fresh"]);
  });

  it("persists and reloads the review-behavior state across sessions", async () => {
    const memory = await store();

    expect(await memory.loadBehavior()).toEqual({ ignoreStreak: 0, autoExtractPaused: false });
    await memory.saveBehavior({ ignoreStreak: 3, autoExtractPaused: true });
    expect(await new MemoryStore({ workspace: memory.workspace, maxEntries: 10, maxEntryChars: 200 }).loadBehavior())
      .toEqual({ ignoreStreak: 3, autoExtractPaused: true });
  });
});
