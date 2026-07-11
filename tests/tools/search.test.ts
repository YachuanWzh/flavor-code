import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { createGlobTool, createGrepTool } from "../../src/tools/search.js";

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "flavor-search-"));
  mkdirSync(join(root, "src", "nested"), { recursive: true });
  mkdirSync(join(root, "ignored"), { recursive: true });
  writeFileSync(join(root, ".gitignore"), "ignored/\n*.log\n");
  writeFileSync(join(root, "src", "a.ts"), "before\nneedle one\nafter\n");
  writeFileSync(join(root, "src", "nested", "b.ts"), "needle two\nlast\n");
  writeFileSync(join(root, "ignored", "secret.ts"), "needle secret\n");
  writeFileSync(join(root, "debug.log"), "needle log\n");
  return root;
}

describe("search tools", () => {
  it("returns identical normalized glob matches from ripgrep and Node", async () => {
    const root = fixture();
    const input = { pattern: "**/*.ts" };
    const signal = new AbortController().signal;

    const ripgrep = await createGlobTool(root).execute(input, signal);
    const node = await createGlobTool(root, { forceNode: true }).execute(input, signal);

    expect(node).toEqual(ripgrep);
    expect(node).toEqual({ matches: ["src/a.ts", "src/nested/b.ts"], truncated: false });
  });

  it("keeps regex, glob, context, and limits in parity", async () => {
    const root = fixture();
    const input = { pattern: "needle\\s+(one|two)", glob: "**/*.ts", context: 1, limit: 1 };
    const signal = new AbortController().signal;

    const ripgrep = await createGrepTool(root).execute(input, signal);
    const node = await createGrepTool(root, { forceNode: true }).execute(input, signal);

    expect(node).toEqual(ripgrep);
    expect(node).toEqual({
      matches: [{ path: "src/a.ts", line: 2, column: 1, text: "needle one", before: ["before"], after: ["after"] }],
      truncated: true,
    });
  });

  it("gives each match its own context when matches share a context line", async () => {
    const root = mkdtempSync(join(tmpdir(), "flavor-search-context-"));
    writeFileSync(join(root, "a.txt"), "first\nhit one\nshared\nhit two\nlast\n");
    const input = { pattern: "hit", context: 1 };
    const signal = new AbortController().signal;

    const ripgrep = await createGrepTool(root).execute(input, signal);
    const node = await createGrepTool(root, { forceNode: true }).execute(input, signal);

    expect(ripgrep).toEqual(node);
  });

  it("applies ancestor ignore files when searching from a subdirectory", async () => {
    const root = mkdtempSync(join(tmpdir(), "flavor-search-scope-"));
    mkdirSync(join(root, "src", "ignored"), { recursive: true });
    writeFileSync(join(root, ".gitignore"), "ignored/\n");
    writeFileSync(join(root, "src", "kept.ts"), "kept\n");
    writeFileSync(join(root, "src", "ignored", "hidden.ts"), "hidden\n");
    const input = { pattern: "**/*.ts", path: "src" };
    const signal = new AbortController().signal;

    const ripgrep = await createGlobTool(root).execute(input, signal);
    const node = await createGlobTool(root, { forceNode: true }).execute(input, signal);

    expect(node).toEqual(ripgrep);
  });

  it("supports brace globs and common file-type filters in Node mode", async () => {
    const root = mkdtempSync(join(tmpdir(), "flavor-search-types-"));
    writeFileSync(join(root, "a.rs"), "needle rust\n");
    writeFileSync(join(root, "b.ts"), "needle typescript\n");
    const signal = new AbortController().signal;

    const globInput = { pattern: "**/*.{rs,ts}" };
    const nodeGlob = await createGlobTool(root, { forceNode: true }).execute(globInput, signal);
    expect(nodeGlob).toEqual(await createGlobTool(root).execute(globInput, signal));
    expect(nodeGlob).toEqual({ matches: ["a.rs", "b.ts"], truncated: false });
    const grepInput = { pattern: "needle", type: "rust" };
    expect(await createGrepTool(root, { forceNode: true }).execute(grepInput, signal))
      .toEqual(await createGrepTool(root).execute(grepInput, signal));
  });
});
