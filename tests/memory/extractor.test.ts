import { describe, expect, it } from "vitest";

import { buildMemoryExtractionPrompt, parseMemoryCandidates } from "../../src/memory/extractor.js";

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
});
