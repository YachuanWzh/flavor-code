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

function fakeRipgrep(root: string, stdout: string): { rgPath: string; rgArgsPrefix: string[] } {
  const script = join(root, "fake-rg.js");
  writeFileSync(script, `process.stdout.write(${JSON.stringify(stdout)});`);
  return { rgPath: process.execPath, rgArgsPrefix: [script] };
}

describe("search tools", () => {
  it("returns identical normalized glob matches from ripgrep and Node", async () => {
    const root = fixture();
    const input = { pattern: "**/*.ts" };
    const signal = new AbortController().signal;

    const ripgrep = await createGlobTool(root).execute(input, signal);
    const node = await createGlobTool(root, { forceNode: true }).execute(input, signal) as { matches: string[]; truncated: boolean };

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

  it("keeps hidden, .ignore, nested rules, and sibling negation in backend parity", async () => {
    const root = mkdtempSync(join(tmpdir(), "flavor-search-ignore-"));
    mkdirSync(join(root, ".hidden"), { recursive: true });
    mkdirSync(join(root, "a"), { recursive: true });
    mkdirSync(join(root, "b"), { recursive: true });
    writeFileSync(join(root, ".ignore"), "*.tmp\n");
    writeFileSync(join(root, ".hidden", "kept.ts"), "hit\n");
    writeFileSync(join(root, "a", ".gitignore"), "*.ts\n!keep.ts\n");
    writeFileSync(join(root, "a", "keep.ts"), "hit\n");
    writeFileSync(join(root, "a", "drop.ts"), "hit\n");
    writeFileSync(join(root, "b", "sibling.ts"), "hit\n");
    writeFileSync(join(root, "ignored.tmp"), "hit\n");
    const input = { pattern: "**/*.ts" };
    const signal = new AbortController().signal;

    expect(await createGlobTool(root, { forceNode: true }).execute(input, signal))
      .toEqual(await createGlobTool(root).execute(input, signal));
  });

  it("rejects unsupported Node file types instead of silently disabling the filter", async () => {
    const root = fixture();
    await expect(createGrepTool(root, { forceNode: true }).execute(
      { pattern: "needle", type: "definitely-unknown" }, new AbortController().signal,
    )).rejects.toThrow(/unsupported file type/i);
  });

  it("skips binary and oversized files and stops once the Node limit is known", async () => {
    const root = mkdtempSync(join(tmpdir(), "flavor-search-bounds-"));
    writeFileSync(join(root, "a.txt"), "hit one\n");
    writeFileSync(join(root, "b.bin"), Buffer.from([0x68, 0x69, 0x74, 0, 0xff]));
    writeFileSync(join(root, "c.txt"), `hit ${"x".repeat(100)}`);
    writeFileSync(join(root, "d.txt"), "hit two\n");
    const result = await createGrepTool(root, { forceNode: true, maxFileBytes: 32 }).execute(
      { pattern: "hit", limit: 1 }, new AbortController().signal,
    );
    expect(result).toEqual({
      matches: [{ path: "a.txt", line: 1, column: 1, text: "hit one", before: [], after: [] }],
      truncated: true,
    });
  });

  it("decodes ripgrep JSON base64 fields without corrupting UTF-8", async () => {
    const root = mkdtempSync(join(tmpdir(), "flavor-search-rg-bytes-"));
    const event = JSON.stringify({
      type: "match",
      data: {
        path: { bytes: Buffer.from("a.txt").toString("base64") },
        lines: { bytes: Buffer.from("hit 😀\n").toString("base64") },
        line_number: 1,
        submatches: [{ start: 0 }],
      },
    });
    const result = await createGrepTool(root, fakeRipgrep(root, `${event}\n`)).execute(
      { pattern: "hit" }, new AbortController().signal,
    );
    expect(result).toEqual({
      matches: [{ path: "a.txt", line: 1, column: 1, text: "hit 😀", before: [], after: [] }],
      truncated: false,
    });
  });

  it("does not silently fall back after partial ripgrep JSON", async () => {
    const root = fixture();
    const valid = JSON.stringify({
      type: "match",
      data: { path: { text: "src/a.ts" }, lines: { text: "needle one\n" }, line_number: 2, submatches: [{ start: 0 }] },
    });
    await expect(createGrepTool(root, fakeRipgrep(root, `${valid}\n{broken`)).execute(
      { pattern: "needle" }, new AbortController().signal,
    )).rejects.toThrow();
  });

  it("selects the same lexical first glob result before applying the limit", async () => {
    const root = mkdtempSync(join(tmpdir(), "flavor-search-order-"));
    mkdirSync(join(root, "a"));
    writeFileSync(join(root, "a", "z.ts"), "hit\n");
    writeFileSync(join(root, "a.ts"), "hit\n");
    writeFileSync(join(root, "b.ts"), "hit\n");
    const input = { pattern: "**/*.ts", limit: 1 };
    const signal = new AbortController().signal;

    const node = await createGlobTool(root, { forceNode: true }).execute(input, signal);
    const rg = await createGlobTool(root).execute(input, signal);
    expect(node).toEqual(rg);
    expect(node).toEqual({ matches: ["a.ts"], truncated: true });
  });

  it("errors conservatively when one directory exceeds the discovery cap", async () => {
    const root = mkdtempSync(join(tmpdir(), "flavor-search-directory-cap-"));
    for (let index = 0; index < 4; index += 1) writeFileSync(join(root, `${index}.ts`), "hit\n");
    await expect(createGlobTool(root, { forceNode: true, maxEntriesPerDirectory: 3 }).execute(
      { pattern: "**/*.ts", limit: 1 }, new AbortController().signal,
    )).rejects.toThrow(/directory.*limit/i);
  });

  it("matches escaped gitignore rules in both backends", async () => {
    const root = mkdtempSync(join(tmpdir(), "flavor-search-ignore-escape-"));
    writeFileSync(join(root, ".gitignore"), "\\#literal.ts\n\\!bang.ts\ntrail\\ \n");
    writeFileSync(join(root, "#literal.ts"), "hit\n");
    writeFileSync(join(root, "!bang.ts"), "hit\n");
    writeFileSync(join(root, "trail "), "hit\n");
    writeFileSync(join(root, "kept.ts"), "hit\n");
    const input = { pattern: "**/*" };
    const signal = new AbortController().signal;
    const node = await createGlobTool(root, { forceNode: true }).execute(input, signal) as { matches: string[]; truncated: boolean };
    expect(node).toEqual(await createGlobTool(root).execute(input, signal));
    expect(node.matches).toContain("kept.ts");
    expect(node.matches).not.toContain("#literal.ts");
    expect(node.matches).not.toContain("!bang.ts");
    expect(node.matches).not.toContain("trail ");
  });

  it("rejects malformed ripgrep base64 payloads", async () => {
    const root = mkdtempSync(join(tmpdir(), "flavor-search-rg-bad-base64-"));
    const event = JSON.stringify({
      type: "match",
      data: { path: { bytes: "%%%" }, lines: { bytes: "not-base64!" }, line_number: 1, submatches: [{ start: 0 }] },
    });
    await expect(createGrepTool(root, fakeRipgrep(root, `${event}\n`)).execute(
      { pattern: "hit" }, new AbortController().signal,
    )).rejects.toThrow(/base64/i);
  });

  it("orders limited glob results by normalized separators", async () => {
    const root = mkdtempSync(join(tmpdir(), "flavor-search-normalized-order-"));
    mkdirSync(join(root, "a"));
    writeFileSync(join(root, "a", "z.ts"), "hit\n");
    writeFileSync(join(root, "a0.ts"), "hit\n");
    const input = { pattern: "**/*.ts", limit: 1 };
    const signal = new AbortController().signal;
    const node = await createGlobTool(root, { forceNode: true }).execute(input, signal);
    const rg = await createGlobTool(root).execute(input, signal);
    expect(rg).toEqual(node);
    expect(rg).toEqual({ matches: ["a/z.ts"], truncated: true });
  });

  it("fails closed when one ignore file exceeds its byte budget", async () => {
    const root = mkdtempSync(join(tmpdir(), "flavor-search-ignore-file-cap-"));
    writeFileSync(join(root, ".gitignore"), "ignored-one\nignored-two\n");
    writeFileSync(join(root, "kept.ts"), "hit\n");
    await expect(createGlobTool(root, { forceNode: true, maxIgnoreFileBytes: 8 }).execute(
      { pattern: "**/*.ts" }, new AbortController().signal,
    )).rejects.toThrow(/ignore file.*byte limit/i);
  });

  it("fails closed when retained ignore layers exceed their cap", async () => {
    const root = mkdtempSync(join(tmpdir(), "flavor-search-ignore-layer-cap-"));
    let directory = root;
    for (let index = 0; index < 4; index += 1) {
      writeFileSync(join(directory, ".gitignore"), `ignored-${index}\n`);
      directory = join(directory, `d${index}`);
      mkdirSync(directory);
    }
    await expect(createGlobTool(root, { maxIgnoreLayers: 2 }).execute(
      { pattern: "**/*.ts" }, new AbortController().signal,
    )).rejects.toThrow(/ignore layer limit/i);
  });

  it("fails closed when ignore traversal exceeds its directory cap", async () => {
    const root = mkdtempSync(join(tmpdir(), "flavor-search-ignore-directory-cap-"));
    for (let index = 0; index < 4; index += 1) mkdirSync(join(root, `d${index}`));
    await expect(createGlobTool(root, { maxIgnoreTraversedDirectories: 2 }).execute(
      { pattern: "**/*.ts" }, new AbortController().signal,
    )).rejects.toThrow(/traversed directory limit/i);
  });
});
