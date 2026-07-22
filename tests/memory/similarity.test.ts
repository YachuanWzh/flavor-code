import { describe, expect, it } from "vitest";

import { memorySimilarity, normalizeForSimilarity } from "../../src/memory/similarity.js";

describe("memory similarity", () => {
  it("normalizes Unicode, punctuation, case, and whitespace", () => {
    expect(normalizeForSimilarity("  Ｕse   PNPM，for scripts! ")).toBe("use pnpm for scripts");
  });

  it("matches English paraphrases and Chinese near-duplicates without equating conflicts", () => {
    expect(memorySimilarity("Use pnpm for all repository scripts", "Repository scripts must use pnpm")).toBeGreaterThan(0.55);
    expect(memorySimilarity("长期记忆应该按任务完成时提取", "任务完成后再提取长期记忆")).toBeGreaterThan(0.45);
    expect(memorySimilarity("Use npm for repository scripts", "Use pnpm for repository scripts")).toBeLessThan(0.92);
  });
});
