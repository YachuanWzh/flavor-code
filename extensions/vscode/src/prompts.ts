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
