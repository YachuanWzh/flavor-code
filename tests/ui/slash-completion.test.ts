import { describe, expect, it } from "vitest";

import {
  buildSlashCandidates,
  completeSlashSelection,
  deriveSlashCompletion,
  matchRanges,
  moveSlashSelection,
  slashCandidatePresentation,
} from "../../src/ui/slash-completion.js";

describe("slash completion", () => {
  const candidates = buildSlashCandidates(
    ["deploy", "help"],
    ["deploy", "doctor"],
    [{ name: "frontend-design", description: "Design interfaces", source: "project" }],
  );

  it("merges sources with command then plugin then skill precedence", () => {
    expect(candidates.map(({ name, kind }) => [name, kind])).toEqual([
      ["deploy", "command"],
      ["help", "command"],
      ["doctor", "plugin"],
      ["frontend-design", "skill"],
    ]);
  });

  it("activates only inside the leading slash token and ranks prefixes first", () => {
    expect(deriveSlashCompletion("/de", 3, candidates, 0)?.items.map((item) => item.name))
      .toEqual(["deploy", "frontend-design"]);
    expect(deriveSlashCompletion("say /de", 7, candidates, 0)).toBeNull();
    expect(deriveSlashCompletion("/deploy now", 11, candidates, 0)).toBeNull();
  });

  it("wraps selection and completes the leading token", () => {
    expect(moveSlashSelection(0, -1, 3)).toBe(2);
    expect(moveSlashSelection(2, 1, 3)).toBe(0);
    expect(completeSlashSelection("/de", 3, "deploy")).toEqual({ text: "/deploy ", cursor: 8 });
  });

  it("returns case-insensitive highlight ranges", () => {
    expect(matchRanges("Frontend-Design", "de")).toEqual([[9, 11]]);
    expect(matchRanges("help", "")).toEqual([]);
  });

  it("uses a marker without row background and highlights only matched text", () => {
    expect(slashCandidatePresentation(true)).toEqual({
      marker: "› ",
      rowStyle: {},
      matchStyle: { color: "ansi:cyan", bold: true },
    });
    expect(slashCandidatePresentation(false).marker).toBe("  ");
  });
});
