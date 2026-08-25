import { describe, expect, it } from "vitest";

import { presentUnifiedDiff } from "../../src/desktop/renderer/git-changes.js";

describe("desktop git diff presentation", () => {
  it("classifies unified diff lines and advances both line-number columns", () => {
    const lines = presentUnifiedDiff([
      "diff --git a/a.ts b/a.ts",
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -3,3 +3,4 @@ function demo()",
      " const before = 1;",
      "-const oldValue = 2;",
      "+const newValue = 2;",
      "+const extra = 3;",
      " return before;",
    ].join("\n"));
    expect(lines.map((line) => line.kind)).toEqual([
      "meta", "meta", "meta", "hunk", "context", "deletion", "addition", "addition", "context",
    ]);
    expect(lines[4]).toMatchObject({ oldNumber: 3, newNumber: 3 });
    expect(lines[5]).toMatchObject({ oldNumber: 4 });
    expect(lines[5]).not.toHaveProperty("newNumber");
    expect(lines[6]).toMatchObject({ newNumber: 4 });
    expect(lines[6]).not.toHaveProperty("oldNumber");
    expect(lines[8]).toMatchObject({ oldNumber: 5, newNumber: 6 });
  });

  it("presents an untracked file as an all-green addition", () => {
    expect(presentUnifiedDiff("one\ntwo\n", true)).toEqual([
      { kind: "addition", marker: "+", text: "one", newNumber: 1 },
      { kind: "addition", marker: "+", text: "two", newNumber: 2 },
    ]);
  });
});
