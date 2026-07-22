import { describe, expect, it } from "vitest";

import {
  buildSlashCandidates,
  completedSlashTokenLength,
  completedSlashTokenPresentation,
  completeSlashSelection,
  deriveSlashCompletion,
  matchRanges,
  moveSlashSelection,
  removeCompletedSlashSelection,
  slashCandidatePresentation,
} from "../../src/ui/slash-completion.js";

describe("slash completion", () => {
  const candidates = buildSlashCandidates(
    [
      { name: "deploy", description: "Deploy the current project" },
      { name: "help", description: "Show available commands" },
    ],
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
    expect(candidates[0]?.description).toBe("Deploy the current project");
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
    expect(completeSlashSelection("/do", 3, "doctor")).toEqual({ text: "/doctor ", cursor: 8 });
    expect(completeSlashSelection("/front", 6, "frontend-design"))
      .toEqual({ text: "/frontend-design ", cursor: 17 });
  });

  it("removes a completed skill or plugin and its separator with one backspace", () => {
    expect(removeCompletedSlashSelection("/doctor ", 7, 8)).toEqual({ text: "", cursor: 0 });
    expect(removeCompletedSlashSelection("/frontend-design ", 16, 17)).toEqual({ text: "", cursor: 0 });
    expect(removeCompletedSlashSelection("/frontend-design  review", 16, 18))
      .toEqual({ text: "review", cursor: 0 });
    expect(removeCompletedSlashSelection("/frontend-design review", 16, 23)).toBeNull();
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

  it("styles only an exact completed slash token after the menu closes", () => {
    expect(completedSlashTokenLength("/deploy ", candidates, false)).toBe(7);
    expect(completedSlashTokenLength("/deploy production --clear", candidates, false)).toBe(7);
    expect(completedSlashTokenLength("/de", candidates, true)).toBe(0);
    expect(completedSlashTokenLength("/unknown value", candidates, false)).toBe(0);
    expect(completedSlashTokenPresentation()).toEqual({ color: "rgb(120,155,255)", bold: true });
  });
});
