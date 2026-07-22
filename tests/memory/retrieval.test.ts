import { describe, expect, it } from "vitest";

import { classifyMemoryHeat, rankMemoryReferences } from "../../src/memory/retrieval.js";
import type { MemoryReference } from "../../src/memory/types.js";

const reference = (overrides: Partial<MemoryReference>): MemoryReference => ({
  id: "aaaaaaaaaaaa", taskId: "task-one", type: "project", summary: "Use pnpm for repository scripts.",
  contentPath: "tasks/task-one.md", topicKey: "project.package-manager", keywords: ["pnpm", "scripts"],
  createdAt: "2026-07-20T00:00:00.000Z", updatedAt: "2026-07-20T00:00:00.000Z",
  recallTotal: 0, recalls: {}, ...overrides,
});

describe("memory retrieval", () => {
  it("ranks relevant bilingual references while respecting top-k and character budgets", () => {
    const refs = [
      reference({ id: "aaaaaaaaaaaa", summary: "Use pnpm for repository scripts.", keywords: ["pnpm", "scripts"] }),
      reference({ id: "bbbbbbbbbbbb", summary: "长期记忆在任务完成时提取。", topicKey: "memory.lifecycle", keywords: ["长期记忆", "任务", "提取"] }),
      reference({ id: "cccccccccccc", summary: "Deploy the service with Docker.", topicKey: "deploy.container", keywords: ["docker", "deploy"] }),
    ];

    expect(rankMemoryReferences(refs, "完成任务后如何提取长期记忆？", {
      now: new Date("2026-07-22T00:00:00.000Z"), topK: 1, maxChars: 200,
    }).map((item) => item.reference.id)).toEqual(["bbbbbbbbbbbb"]);
  });

  it("classifies heat from distinct task recalls and treats heat only as a ranking modifier", () => {
    const hot = reference({ recalls: Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`task-${i}`, "2026-07-21T00:00:00.000Z"])) });
    const cold = reference({ createdAt: "2026-07-01T00:00:00.000Z", recalls: {} });
    const now = new Date("2026-07-22T00:00:00.000Z");

    expect(classifyMemoryHeat(hot, now)).toBe("hot");
    expect(classifyMemoryHeat(cold, now)).toBe("cold");
  });
});
