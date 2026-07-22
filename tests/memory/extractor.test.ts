import { describe, expect, it } from "vitest";

import { buildMemoryExtractionPrompt, parseMemoryCandidates, parseScoredMemoryCandidates } from "../../src/memory/extractor.js";

describe("memory extraction", () => {
  it("builds a bounded prompt with taxonomy and exclusion rules", () => {
    const prompt = buildMemoryExtractionPrompt([
      { role: "user", content: "Please remember that this repository uses pnpm." },
      { role: "assistant", content: "Understood." },
      { role: "tool", content: "secret tool output", toolCallId: "call" },
    ]);

    expect(prompt).toContain("user | feedback | project | reference");
    expect(prompt).toContain("Do not retain secrets");
    expect(prompt).toContain("this repository uses pnpm");
    expect(prompt).not.toContain("secret tool output");
  });

  it("parses strict or fenced JSON and filters unsupported, duplicate, overlong, and sensitive candidates", () => {
    const parsed = parseMemoryCandidates(`\`\`\`json
      {"memories":[
        {"type":"project","content":"Use pnpm for scripts."},
        {"type":"project","content":" use  pnpm for scripts. "},
        {"type":"other","content":"unsupported"},
        {"type":"reference","content":"password=hunter2"},
        {"type":"user","content":"${"x".repeat(51)}"}
      ]}
    \`\`\``, { maxEntryChars: 50 });

    expect(parsed).toEqual([{ type: "project", content: "Use pnpm for scripts." }]);
  });

  it("fails closed for malformed model output", () => {
    expect(() => parseMemoryCandidates("I found one useful memory", { maxEntryChars: 100 }))
      .toThrow(/JSON/i);
    expect(() => parseMemoryCandidates('{"memories":"wrong"}', { maxEntryChars: 100 }))
      .toThrow(/memories/i);
  });

  it("lets the host enforce the four-dimensional score threshold", () => {
    const raw = JSON.stringify({ memories: [
      {
        type: "project", summary: "Use pnpm", content: "Use pnpm for repository scripts.",
        topicKey: "project.package-manager", keywords: ["pnpm", "scripts"],
        scores: { durability: 3, futureUtility: 3, authority: 3, nonDerivability: 1 },
      },
      {
        type: "feedback", summary: "Temporary wording", content: "Use a different sentence in this answer.",
        topicKey: "answer.wording", keywords: ["wording"],
        scores: { durability: 1, futureUtility: 2, authority: 3, nonDerivability: 3 },
      },
    ] });

    expect(parseScoredMemoryCandidates(raw, { maxEntryChars: 200, scoreThreshold: 9, maxCandidates: 3 }))
      .toEqual([expect.objectContaining({ type: "project", summary: "Use pnpm", topicKey: "project.package-manager" })]);
  });
});
