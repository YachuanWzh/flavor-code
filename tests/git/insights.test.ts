import { describe, expect, it } from "vitest";

import { cleanCommitMessage, formatReviewReport, type ReviewReport } from "../../src/git/insights.js";

describe("cleanCommitMessage", () => {
  it("passes through a plain message unchanged", () => {
    expect(cleanCommitMessage("feat(cli): add /commit\n\nShort body.")).toBe("feat(cli): add /commit\n\nShort body.");
  });

  it("strips code fences and trailing commentary", () => {
    const raw = "```\nfeat(cli): add /commit\n\nNotes: generated because the diff touches the cli.\n```";
    expect(cleanCommitMessage(raw)).toBe("feat(cli): add /commit");
  });

  it("cuts commentary markers even without fences", () => {
    const raw = "fix(parser): handle empty input\n\nHere's a summary of why this change is safe.";
    expect(cleanCommitMessage(raw)).toBe("fix(parser): handle empty input");
  });

  it("returns an empty string for whitespace-only output", () => {
    expect(cleanCommitMessage("   \n  ")).toBe("");
  });

  it("caps very long messages", () => {
    expect(cleanCommitMessage(`chore: ${"x".repeat(5_000)}`)).toHaveLength(2_000);
  });
});

describe("formatReviewReport", () => {
  it("renders verdict, summary, findings, and fix suggestions", () => {
    const report: ReviewReport = {
      summary: "Solid change overall.",
      verdict: "ship-with-fixes",
      findings: [
        { severity: "critical", file: "src/a.ts", line: "42", issue: "possible null deref", suggestion: "guard the value" },
        { severity: "nit", file: "src/b.ts", line: "", issue: "unused import", suggestion: "" },
      ],
    };
    const text = formatReviewReport(report);
    expect(text).toContain("Review verdict: ship-with-fixes");
    expect(text).toContain("Solid change overall.");
    expect(text).toContain("- [critical] src/a.ts:42 — possible null deref");
    expect(text).toContain("  fix: guard the value");
    // Empty line and empty suggestion render without dangling separators.
    expect(text).toContain("- [nit] src/b.ts — unused import");
    expect(text).not.toContain("src/b.ts:");
  });

  it("reports a clean review without a findings block", () => {
    const text = formatReviewReport({ summary: "Looks good.", verdict: "ship", findings: [] });
    expect(text).toContain("Review verdict: ship");
    expect(text).toContain("No issues found.");
    expect(text).not.toContain("Findings:");
  });
});
