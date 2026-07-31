import { describe, expect, it } from "vitest";

import {
  diagnosticPrompt,
  diagnosticsPrompt,
  selectionPrompt,
  symbolPrompt,
} from "../../extensions/vscode/src/prompts.js";

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

  it("keeps explain actions read-only", () => {
    expect(diagnosticPrompt({
      action: "explain",
      relativePath: "src/app.ts",
      line: 9,
      severity: "Error",
      message: "Cannot find name x",
    })).toContain("Do not edit files");
  });

  it("builds focused symbol prompts", () => {
    expect(symbolPrompt({ action: "tests", relativePath: "src/app.ts", line: 4 }))
      .toContain("src/app.ts:4");
  });
});
