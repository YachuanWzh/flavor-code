import { describe, expect, it } from "vitest";

import { diagnosticsPrompt, selectionPrompt } from "../../extensions/vscode/src/prompts.js";

describe("VS Code prompt builders", () => {
  it("builds a bounded selection prompt with file coordinates", () => {
    expect(selectionPrompt({
      relativePath: "src/app.ts",
      startLine: 4,
      endLine: 6,
      selection: "const answer = 42;",
    })).toContain("src/app.ts:4-6");
  });

  it("builds a diagnostics prompt without embedding source text", () => {
    const prompt = diagnosticsPrompt([
      { relativePath: "src/app.ts", line: 9, severity: "error", message: "Cannot find name x" },
    ]);
    expect(prompt).toContain("src/app.ts:9");
    expect(prompt).toContain("Cannot find name x");
  });
});
