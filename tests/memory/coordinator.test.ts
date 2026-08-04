import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MemoryCoordinator } from "../../src/memory/coordinator.js";
import { MemoryStore } from "../../src/memory/store.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function fixture(generate: (prompt: string, signal: AbortSignal) => Promise<string>, minChars = 200, autoStoreThreshold = 11) {
  const workspace = await mkdtemp(join(tmpdir(), "flavor-memory-coordinator-")); roots.push(workspace);
  const store = new MemoryStore({ workspace, maxEntries: 20, maxEntryChars: 200 });
  const review = vi.fn();
  const remember = vi.fn(async () => 1);
  return { store, review, remember, coordinator: new MemoryCoordinator({
    review, remember, generate, minChars, maxEntryChars: 200, scoreThreshold: 9, maxCandidates: 3, autoStoreThreshold,
  }) };
}

describe("MemoryCoordinator", () => {
  it("queues extraction for review without writing and flushes deterministically", async () => {
    const generate = vi.fn(async (_prompt: string, _signal: AbortSignal) => JSON.stringify({ memories: [{
      type: "project", summary: "Use pnpm", content: "Use pnpm.", topicKey: "project.package-manager", keywords: ["pnpm"],
      scores: { durability: 3, futureUtility: 3, authority: 3, nonDerivability: 1 },
    }] }));
    const { store, review, coordinator } = await fixture(generate);

    expect(await coordinator.finalize("task-one", [
      { role: "user", content: "Remember the package manager." },
      { role: "assistant", content: `The project uses pnpm. ${"Useful completed task context. ".repeat(8)}` },
    ])).toEqual({ evaluated: true, candidates: true, stored: 0 });

    expect(generate).toHaveBeenCalledOnce();
    expect(generate.mock.calls[0]?.[0]).toContain("project uses pnpm");
    expect(review).toHaveBeenCalledWith("task-one", [expect.objectContaining({ type: "project", content: "Use pnpm." })]);
    expect(await store.list()).toEqual([]);
  });

  it("auto-stores high-confidence candidates without entering the review queue", async () => {
    const generate = vi.fn(async (_prompt: string, _signal: AbortSignal) => JSON.stringify({ memories: [{
      type: "project", summary: "Use pnpm", content: "Use pnpm for all repository scripts.",
      topicKey: "project.package-manager", keywords: ["pnpm"],
      scores: { durability: 3, futureUtility: 3, authority: 3, nonDerivability: 3 },
    }] }));
    const { store, review, remember, coordinator } = await fixture(generate);

    expect(await coordinator.finalize("task-high", [
      { role: "user", content: "Remember the package manager." },
      { role: "assistant", content: `The project uses pnpm. ${"Useful completed task context. ".repeat(8)}` },
    ])).toEqual({ evaluated: true, candidates: true, stored: 1 });

    expect(remember).toHaveBeenCalledWith("task-high", [expect.objectContaining({ type: "project", content: "Use pnpm for all repository scripts." })]);
    expect(review).not.toHaveBeenCalled();
    expect(await store.list()).toEqual([]);
  });

  it("respects a custom auto-store threshold for splitting direct writes from reviews", async () => {
    const candidate = {
      type: "feedback" as const, summary: "Keep answers concise", content: "Keep answers concise for the user.",
      topicKey: "user.response-style", keywords: ["concise"],
      scores: { durability: 3, futureUtility: 3, authority: 3, nonDerivability: 1 },
    };
    const generate = vi.fn(async (_prompt: string, _signal: AbortSignal) => JSON.stringify({ memories: [candidate] }));
    const messages = [
      { role: "user" as const, content: "Remember the package manager." },
      { role: "assistant" as const, content: `The project uses pnpm. ${"Useful completed task context. ".repeat(8)}` },
    ];

    // Threshold 9: total 10 is high confidence, stored directly.
    const low = await fixture(generate, 200, 9);
    expect(await low.coordinator.finalize("task-low", messages)).toEqual({ evaluated: true, candidates: true, stored: 1 });
    expect(low.remember).toHaveBeenCalledWith("task-low", [expect.objectContaining({ type: "feedback", content: "Keep answers concise for the user." })]);
    expect(low.review).not.toHaveBeenCalled();

    // Threshold 12: the same total-10 candidate still needs review.
    const high = await fixture(generate, 200, 12);
    expect(await high.coordinator.finalize("task-high", messages)).toEqual({ evaluated: true, candidates: true, stored: 0 });
    expect(high.remember).not.toHaveBeenCalled();
    expect(high.review).toHaveBeenCalledWith("task-high", [expect.objectContaining({ type: "feedback", content: "Keep answers concise for the user." })]);
  });

  it("skips short turns and isolates a failed extraction from later work", async () => {
    const failures: string[] = [];
    let call = 0;
    const { store, review, coordinator } = await fixture(async () => {
      call += 1;
      if (call === 1) throw new Error("provider offline");
      return JSON.stringify({ memories: [{
        type: "feedback", summary: "Do not commit", content: "Do not commit automatically.", topicKey: "agent.git.commit", keywords: ["commit"],
        scores: { durability: 3, futureUtility: 3, authority: 3, nonDerivability: 1 },
      }] });
    }, 200);
    coordinator.onError = (error) => failures.push(error instanceof Error ? error.message : String(error));

    expect(await coordinator.finalize("short-task", [{ role: "user", content: "short" }]))
      .toEqual({ evaluated: true, candidates: false, stored: 0 });
    await expect(coordinator.finalize("failed-task", [{ role: "user", content: `This task is long enough to fail once. ${"context ".repeat(30)}` }]))
      .resolves.toEqual({ evaluated: false, candidates: false, stored: 0 });
    await expect(coordinator.finalize("later-task", [{ role: "user", content: `This later completed task must still be processed. ${"context ".repeat(30)}` }]))
      .resolves.toEqual({ evaluated: true, candidates: true, stored: 0 });

    expect(failures).toEqual(["provider offline"]);
    expect(review).toHaveBeenCalledWith("later-task", [expect.objectContaining({ type: "feedback", content: "Do not commit automatically." })]);
    expect(await store.list()).toEqual([]);
  });

  it("analyzes a short explicit request and writes it without entering the review queue", async () => {
    const generate = vi.fn(async (_prompt: string, _signal: AbortSignal) => JSON.stringify({ memories: [{
      type: "user", summary: "Prefer concise answers", content: "The user prefers concise answers.",
      topicKey: "user.response-style", keywords: ["concise"],
      scores: { durability: 3, futureUtility: 3, authority: 3, nonDerivability: 2 },
    }] }));
    const { coordinator, remember, review } = await fixture(generate);

    await expect(coordinator.rememberExplicit("task-explicit", [
      { role: "user", content: "请记住我喜欢简洁回答。" },
      { role: "assistant", content: "好的。" },
    ])).resolves.toEqual({ evaluated: true, candidates: true, stored: 1 });

    expect(generate).toHaveBeenCalledOnce();
    expect(generate.mock.calls[0]![0]).toContain("explicitly asked");
    expect(remember).toHaveBeenCalledWith("task-explicit", [expect.objectContaining({ type: "user" })]);
    expect(review).not.toHaveBeenCalled();
  });
});
