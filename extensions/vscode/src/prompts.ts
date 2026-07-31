export function selectionPrompt(input: {
  relativePath: string;
  startLine: number;
  endLine: number;
  selection: string;
}): string {
  const selection = input.selection.slice(0, 100_000);
  return [
    `Work on the selected code at ${input.relativePath}:${input.startLine}-${input.endLine}.`,
    "Inspect the repository context before editing and verify the result.",
    "Selected code:",
    "```",
    selection,
    "```",
  ].join("\n");
}

export function diagnosticsPrompt(diagnostics: readonly {
  relativePath: string;
  line: number;
  severity: string;
  message: string;
}[]): string {
  const lines = diagnostics.slice(0, 200).map((item) =>
    `- ${item.relativePath}:${item.line} [${item.severity}] ${item.message.slice(0, 2_000)}`);
  return [
    "Fix the following VS Code diagnostics. Inspect the actual files, make the smallest coherent changes, and run relevant checks.",
    ...lines,
  ].join("\n");
}

export function diagnosticPrompt(input: {
  action: "fix" | "explain";
  relativePath: string;
  line: number;
  severity: string;
  message: string;
}): string {
  if (input.action === "explain") {
    return [
      `Explain the ${input.severity.toLowerCase()} diagnostic at ${input.relativePath}:${input.line}:`,
      input.message,
      "Inspect the relevant code and explain the root cause, impact, and safest fix. Do not edit files.",
    ].join("\n");
  }
  return [
    `Fix the ${input.severity.toLowerCase()} diagnostic at ${input.relativePath}:${input.line}:`,
    input.message,
    "Inspect the relevant code, make the smallest coherent fix, and run focused verification.",
  ].join("\n");
}

export function symbolPrompt(input: {
  action: "review" | "tests";
  relativePath: string;
  line: number;
}): string {
  if (input.action === "tests") {
    return `Add focused tests for the symbol at ${input.relativePath}:${input.line}. Inspect its implementation and existing test conventions, cover meaningful edge cases, and run the focused tests.`;
  }
  return `Review the symbol at ${input.relativePath}:${input.line}. Focus on correctness, regressions, security, and missing tests. Report concrete findings first and only edit files if a fix is clearly necessary.`;
}
