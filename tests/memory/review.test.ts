import { describe, expect, it, vi } from "vitest";

import { MemoryReviewBridge } from "../../src/memory/review.js";

describe("MemoryReviewBridge", () => {
  it("stages generated candidates and writes only an explicitly accepted item", async () => {
    const remember = vi.fn(async () => undefined);
    const changed = vi.fn();
    const reviews = new MemoryReviewBridge({ remember, onChange: changed });

    expect(reviews.offer([
      { type: "project", content: "Use pnpm." },
      { type: "feedback", content: "Do not commit automatically." },
    ])).toBe(2);
    expect(remember).not.toHaveBeenCalled();
    expect(reviews.pending).toHaveLength(2);

    const accepted = reviews.pending[0]!;
    await reviews.accept(accepted.id);

    expect(remember).toHaveBeenCalledOnce();
    expect(remember).toHaveBeenCalledWith(expect.objectContaining({ type: "project", content: "Use pnpm." }));
    expect(reviews.pending).toEqual([expect.objectContaining({ type: "feedback" })]);
    expect(changed).toHaveBeenCalled();
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
});
