import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { MAX_PENDING_MEMORY_REVIEWS, MemoryReviewBridge } from "../../src/memory/review.js";

describe("MemoryReviewBridge", () => {
  it("persists a bounded review inbox across restarts until a candidate is accepted", async () => {
    const root = await mkdtemp(join(tmpdir(), "flavor-review-inbox-"));
    try {
      const path = join(root, "review-inbox.json");
      const remember = vi.fn(async () => undefined);
      const first = new MemoryReviewBridge({ storagePath: path, remember });
      await first.initialize();
      first.offer("task-one", [{ type: "project", content: "Use pnpm.", summary: "Use pnpm", topicKey: "project.package-manager",
        keywords: ["pnpm"], scores: { durability: 3, futureUtility: 3, authority: 3, nonDerivability: 3 }, evidence: "Use pnpm." }]);
      await first.flush();
      first.dispose();

      const second = new MemoryReviewBridge({ storagePath: path, remember });
      await second.initialize();
      expect(second.pending).toMatchObject([{ content: "Use pnpm.", taskId: "task-one", evidence: "Use pnpm." }]);
      expect(second.stats).toEqual({ offered: 1, accepted: 0, dismissed: 0, pending: 1 });
      expect(await second.accept(second.pending[0]!.id)).toBe(true);
      const third = new MemoryReviewBridge({ storagePath: path, remember });
      await third.initialize();
      expect(third.pending).toEqual([]);
      expect(third.stats).toEqual({ offered: 1, accepted: 1, dismissed: 0, pending: 0 });
      expect(remember).toHaveBeenCalledOnce();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("caps the durable inbox and rejects sensitive review metadata", async () => {
    const root = await mkdtemp(join(tmpdir(), "flavor-review-inbox-"));
    try {
      const path = join(root, "review-inbox.json");
      const reviews = new MemoryReviewBridge({ storagePath: path, remember: async () => undefined });
      await reviews.initialize();
      expect(reviews.offer("task-one", [{ type: "project", content: "Use pnpm.", summary: "password=hunter2",
        topicKey: "project.package-manager", keywords: [],
        scores: { durability: 3, futureUtility: 3, authority: 3, nonDerivability: 3 } }])).toBe(0);
      expect(reviews.offer(Array.from({ length: MAX_PENDING_MEMORY_REVIEWS + 1 }, (_, index) =>
        ({ type: "project" as const, content: `Durable fact ${index}.` })))).toBe(MAX_PENDING_MEMORY_REVIEWS);
      await reviews.flush();
      const restored = new MemoryReviewBridge({ storagePath: path, remember: async () => undefined });
      await restored.initialize();
      expect(restored.pending).toHaveLength(MAX_PENDING_MEMORY_REVIEWS);
      expect(restored.pending.every((item) => !item.content.includes("password"))).toBe(true);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("stages at most one generated candidate and writes only an explicitly accepted item", async () => {
    const remember = vi.fn(async () => undefined);
    const changed = vi.fn();
    const reviews = new MemoryReviewBridge({ remember, onChange: changed });

    expect(reviews.offer([
      { type: "project", content: "Use pnpm." },
      { type: "feedback", content: "Do not commit automatically." },
    ])).toBe(1);
    expect(remember).not.toHaveBeenCalled();
    expect(reviews.pending).toHaveLength(1);

    const accepted = reviews.pending[0]!;
    await reviews.accept(accepted.id);

    expect(remember).toHaveBeenCalledOnce();
    expect(remember).toHaveBeenCalledWith(expect.objectContaining({ type: "project", content: "Use pnpm." }));
    expect(reviews.pending).toEqual([]);
    expect(changed).toHaveBeenCalled();
  });

  it("dismisses every pending candidate when a new query supersedes the review", () => {
    const changed = vi.fn();
    const reviews = new MemoryReviewBridge({ remember: async () => undefined, onChange: changed });
    reviews.offer([{ type: "project", content: "Use pnpm." }]);

    expect(reviews.dismissAll()).toBe(1);
    expect(reviews.pending).toEqual([]);
    expect(changed).toHaveBeenCalledTimes(2);
    expect(reviews.dismissAll()).toBe(0);
  });

  it("dismisses candidates without writing and de-duplicates pending content", async () => {
    const remember = vi.fn(async () => undefined);
    const reviews = new MemoryReviewBridge({ remember });
    const candidate = { type: "project" as const, content: "Use pnpm." };

    expect(reviews.offer([candidate, { ...candidate, content: " use   pnpm. " }])).toBe(1);
    expect(reviews.dismiss(reviews.pending[0]!.id)).toBe(true);
    expect(reviews.pending).toEqual([]);
    expect(remember).not.toHaveBeenCalled();
  });

  it("retains a candidate when the confirmed write fails", async () => {
    const reviews = new MemoryReviewBridge({ remember: async () => { throw new Error("disk full"); } });
    reviews.offer([{ type: "project", content: "Use pnpm." }]);

    await expect(reviews.accept(reviews.pending[0]!.id)).rejects.toThrow("disk full");
    expect(reviews.pending).toHaveLength(1);
  });

  it("does not dismiss or save a candidate twice while its first save is running", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const remember = vi.fn(async () => { await gate; });
    const reviews = new MemoryReviewBridge({ remember });
    reviews.offer([{ type: "project", content: "Use pnpm." }]);
    const id = reviews.pending[0]!.id;

    const first = reviews.accept(id);
    expect(reviews.dismiss(id)).toBe(false);
    await expect(reviews.accept(id)).resolves.toBe(false);
    release();
    await expect(first).resolves.toBe(true);
    expect(remember).toHaveBeenCalledOnce();
    expect(reviews.stats).toEqual({ offered: 1, accepted: 1, dismissed: 0, pending: 0 });
  });

  it("reports explicit dismissals and acceptances so the host can learn review behavior", async () => {
    const remember = vi.fn(async () => undefined);
    const onDismiss = vi.fn();
    const onAccept = vi.fn();
    const reviews = new MemoryReviewBridge({ remember, onDismiss, onAccept });
    reviews.offer([{ type: "project", content: "Use pnpm." }]);

    expect(reviews.dismiss(reviews.pending[0]!.id)).toBe(true);
    expect(onDismiss).toHaveBeenCalledOnce();
    expect(reviews.dismiss("memory-review-missing")).toBe(false);
    expect(onDismiss).toHaveBeenCalledOnce();

    reviews.offer([{ type: "project", content: "Use pnpm." }]);
    await reviews.accept(reviews.pending[0]!.id);
    expect(onAccept).toHaveBeenCalledOnce();
  });

  it("auto-dismisses an unconfirmed candidate after the configured seconds without learning a user dismissal", () => {
    vi.useFakeTimers();
    try {
      const remember = vi.fn(async () => undefined);
      const changed = vi.fn();
      const onDismiss = vi.fn();
      const reviews = new MemoryReviewBridge({
        remember, onChange: changed, onDismiss, autoDismissSeconds: 1,
      });
      expect(reviews.autoDismissSeconds).toBe(1);

      reviews.offer([{ type: "project", content: "Use pnpm." }]);
      expect(reviews.pending).toHaveLength(1);

      vi.advanceTimersByTime(1_000);
      expect(reviews.pending).toEqual([]);
      expect(remember).not.toHaveBeenCalled();
      expect(onDismiss).not.toHaveBeenCalled();
      expect(changed).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("accepting or dismissing a candidate cancels its auto-dismiss timer", async () => {
    vi.useFakeTimers();
    try {
      const remember = vi.fn(async () => undefined);
      const reviews = new MemoryReviewBridge({ remember, autoDismissSeconds: 60 });
      reviews.offer([{ type: "project", content: "Use pnpm." }]);
      await reviews.accept(reviews.pending[0]!.id);

      vi.advanceTimersByTime(120_000);
      expect(reviews.pending).toEqual([]);
      expect(remember).toHaveBeenCalledOnce();

      reviews.offer([{ type: "project", content: "Do not commit automatically." }]);
      reviews.dismiss(reviews.pending[0]!.id);
      vi.advanceTimersByTime(120_000);
      expect(reviews.pending).toEqual([]);
      expect(remember).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps candidates forever when autoDismissSeconds is zero", () => {
    vi.useFakeTimers();
    try {
      const reviews = new MemoryReviewBridge({ remember: async () => undefined, autoDismissSeconds: 0 });
      expect(reviews.autoDismissSeconds).toBe(0);

      reviews.offer([{ type: "project", content: "Use pnpm." }]);
      vi.advanceTimersByTime(120_000);
      expect(reviews.pending).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
