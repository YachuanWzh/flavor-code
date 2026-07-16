import { describe, expect, it } from "vitest";

import {
  buildMentionCandidates,
  completeMentionSelection,
  deriveMentionCompletion,
  mentionCandidatePresentation,
  moveMentionSelection,
} from "../../src/ui/mention-completion.js";

describe("mention completion", () => {
  const candidates = buildMentionCandidates([
    "src/ui/app.tsx",
    "docs/app-notes.md",
    "src/app.test.ts",
    "docs/my notes.md",
    "src\\ui\\app.tsx",
  ]);

  it("normalizes and de-duplicates workspace paths", () => {
    expect(candidates).toEqual([
      "docs/app-notes.md",
      "docs/my notes.md",
      "src/app.test.ts",
      "src/ui/app.tsx",
    ]);
  });

  it("opens for a whitespace-delimited at token and rejects email text", () => {
    expect(deriveMentionCompletion("review @app", 11, candidates, 0)?.items)
      .toEqual(["docs/app-notes.md", "src/app.test.ts", "src/ui/app.tsx"]);
    expect(deriveMentionCompletion("@app", 4, candidates, 0)?.query).toBe("app");
    expect(deriveMentionCompletion("me@example.com", 14, candidates, 0)).toBeNull();
  });

  it("keeps completion active when the cursor moves inside its token", () => {
    const completion = deriveMentionCompletion("review @app later", 9, candidates, 0);
    expect(completion?.query).toBe("app");
    expect(completion?.items).toEqual(["docs/app-notes.md", "src/app.test.ts", "src/ui/app.tsx"]);
  });

  it("wraps selection and keeps the selected row in a bounded window", () => {
    expect(moveMentionSelection(0, -1, 3)).toBe(2);
    expect(moveMentionSelection(2, 1, 3)).toBe(0);
    expect(deriveMentionCompletion(
      "@",
      1,
      Array.from({ length: 8 }, (_, index) => `${index}.ts`),
      7,
      6,
    )?.windowStart).toBe(2);
  });

  it("replaces only the active token and escapes spaces", () => {
    expect(completeMentionSelection("review @my later", 10, "docs/my notes.md"))
      .toEqual({ text: "review @docs/my\\ notes.md later", cursor: 26 });
  });

  it("highlights all text in the selected row like the reference", () => {
    expect(mentionCandidatePresentation(true)).toEqual({
      marker: "› ",
      textStyle: { color: "rgb(120,155,255)", bold: true },
      highlightMatches: false,
      matchStyle: { color: "ansi:cyan", bold: true },
    });
    expect(mentionCandidatePresentation(false)).toEqual({
      marker: "  ",
      textStyle: {},
      highlightMatches: true,
      matchStyle: { color: "ansi:cyan", bold: true },
    });
  });
});
