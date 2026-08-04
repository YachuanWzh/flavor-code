import { describe, expect, it, vi } from "vitest";

import { MemoryReviewBridge } from "../../src/memory/review.js";

describe("MemoryReviewBridge", () => {
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
