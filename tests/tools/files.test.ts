import { existsSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { createApplyPatchTool, createEditTool, createReadTool, createWriteTool } from "../../src/tools/files.js";

describe("file tools", () => {
  it("Read rejects binary files", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "flavor-files-"));
    const path = join(workspace, "binary.dat");
    writeFileSync(path, Buffer.from([65, 0, 66]));

    await expect(createReadTool(workspace).execute({ path }, new AbortController().signal))
      .rejects.toThrow(/binary/i);
  });

  it("Read rejects invalid UTF-8 binary data without NUL bytes", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "flavor-files-"));
    const path = join(workspace, "binary.dat");
    writeFileSync(path, Buffer.from([0xff, 0xfe, 0xfd]));

    await expect(createReadTool(workspace).execute({ path }, new AbortController().signal))
      .rejects.toThrow(/binary/i);
  });

  it("Read validates the entire accepted buffer for late binary bytes", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "flavor-files-"));
    for (const suffix of [Buffer.from([0]), Buffer.from([0xff])]) {
      const path = join(workspace, `late-${suffix[0]}.dat`);
      writeFileSync(path, Buffer.concat([Buffer.alloc(9_000, 65), suffix]));

      await expect(createReadTool(workspace).execute({ path, maxBytes: 10_000 }, new AbortController().signal))
        .rejects.toThrow(/binary/i);
    }
  });

  it("Read rechecks actual bytes when a file grows after stat", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "flavor-files-"));
    const path = join(workspace, "growing.txt");
    writeFileSync(path, "a");
    vi.resetModules();
    vi.doMock("node:fs/promises", async () => {
      const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
      return {
        ...actual,
        stat: async (...args: Parameters<typeof actual.stat>) => ({ ...(await actual.stat(...args)), size: 1 }),
        readFile: async () => Buffer.from("grew"),
      };
    });
    try {
      const { createReadTool: createMockedReadTool } = await import("../../src/tools/files.js");
      await expect(createMockedReadTool(workspace).execute({ path, maxBytes: 1 }, new AbortController().signal))
        .rejects.toThrow(/limit/i);
    } finally {
      vi.doUnmock("node:fs/promises");
      vi.resetModules();
    }
  });

  it("Edit fails unless oldText has exactly one match", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "flavor-files-"));
    const path = join(workspace, "file.txt");
    writeFileSync(path, "same\nsame\n");

    await expect(createEditTool(workspace).execute({ path, oldText: "same", newText: "new" }, new AbortController().signal))
      .rejects.toThrow(/exactly once/i);
    expect(readFileSync(path, "utf8")).toBe("same\nsame\n");
  });

  it("Write atomically replaces content and leaves no temporary file", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "flavor-files-"));
    const path = join(workspace, "file.txt");
    writeFileSync(path, "old");

    await createWriteTool(workspace).execute({ path, content: "new" }, new AbortController().signal);

    expect(readFileSync(path, "utf8")).toBe("new");
    expect(readdirSync(workspace).filter((name) => name.startsWith("file.txt.") && name.endsWith(".tmp"))).toEqual([]);
  });

  it("normalizes paths and prevents symlink escape", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "flavor-files-"));
    const outside = mkdtempSync(join(tmpdir(), "flavor-outside-"));
    const link = join(workspace, "link");
    symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir");

    await expect(createWriteTool(workspace).execute({ path: join(link, "escaped.txt"), content: "no" }, new AbortController().signal))
      .rejects.toThrow(/workspace/i);
    expect(existsSync(join(outside, "escaped.txt"))).toBe(false);
  });

  it("ApplyPatch rejects every path outside the workspace", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "flavor-files-"));
    const outside = join(workspace, "..", "escaped.txt").replaceAll("\\", "/");
    const patch = `--- /dev/null\n+++ b/${outside}\n@@ -0,0 +1 @@\n+escaped\n`;

    await expect(createApplyPatchTool(workspace).execute({ patch }, new AbortController().signal))
      .rejects.toThrow(/workspace/i);
    expect(existsSync(join(workspace, "..", "escaped.txt"))).toBe(false);
  });

  it("ApplyPatch applies a unified diff inside the workspace", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "flavor-files-"));
    const path = join(workspace, "file.txt");
    writeFileSync(path, "old\n");
    const patch = "--- a/file.txt\n+++ b/file.txt\n@@ -1 +1 @@\n-old\n+new\n";

    await createApplyPatchTool(workspace).execute({ patch }, new AbortController().signal);

    expect(readFileSync(path, "utf8")).toBe("new\n");
  });

  it("ApplyPatch creation refuses to overwrite an existing binary file", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "flavor-files-"));
    const path = join(workspace, "file.dat");
    const original = Buffer.from([0xff, 0, 0xfe]);
    writeFileSync(path, original);
    const patch = "--- /dev/null\n+++ b/file.dat\n@@ -0,0 +1 @@\n+replacement\n";

    await expect(createApplyPatchTool(workspace).execute({ patch }, new AbortController().signal))
      .rejects.toThrow(/exist/i);
    expect(readFileSync(path)).toEqual(original);
  });

  it("ApplyPatch rejects deletion and differing old/new paths", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "flavor-files-"));
    writeFileSync(join(workspace, "old.txt"), "old\n");
    writeFileSync(join(workspace, "new.txt"), "old\n");
    const deletion = "--- a/old.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-old\n";
    const rename = "--- a/old.txt\n+++ b/new.txt\n@@ -1 +1 @@\n-old\n+new\n";

    await expect(createApplyPatchTool(workspace).execute({ patch: deletion }, new AbortController().signal))
      .rejects.toThrow(/deletion/i);
    await expect(createApplyPatchTool(workspace).execute({ patch: rename }, new AbortController().signal))
      .rejects.toThrow(/differ|rename/i);
    expect(readFileSync(join(workspace, "old.txt"), "utf8")).toBe("old\n");
    expect(readFileSync(join(workspace, "new.txt"), "utf8")).toBe("old\n");
  });

  it("ApplyPatch rejects multi-file patches before changing either file", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "flavor-files-"));
    writeFileSync(join(workspace, "a.txt"), "old-a\n");
    writeFileSync(join(workspace, "b.txt"), "old-b\n");
    const patch = [
      "--- a/a.txt", "+++ b/a.txt", "@@ -1 +1 @@", "-old-a", "+new-a",
      "--- a/b.txt", "+++ b/b.txt", "@@ -1 +1 @@", "-old-b", "+new-b", "",
    ].join("\n");

    await expect(createApplyPatchTool(workspace).execute({ patch }, new AbortController().signal))
      .rejects.toThrow(/single|multiple/i);
    expect(readFileSync(join(workspace, "a.txt"), "utf8")).toBe("old-a\n");
    expect(readFileSync(join(workspace, "b.txt"), "utf8")).toBe("old-b\n");
  });

  it("ApplyPatch rejects malformed hunk counts without changing the file", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "flavor-files-"));
    const path = join(workspace, "file.txt");
    writeFileSync(path, "old\n");
    const patch = "--- a/file.txt\n+++ b/file.txt\n@@ -1,2 +1,2 @@\n-old\n+new\n";

    await expect(createApplyPatchTool(workspace).execute({ patch }, new AbortController().signal))
      .rejects.toThrow(/count/i);
    expect(readFileSync(path, "utf8")).toBe("old\n");
  });

  it("ApplyPatch rejects no-final-newline markers instead of changing semantics", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "flavor-files-"));
    const path = join(workspace, "file.txt");
    writeFileSync(path, "old");
    const patch = "--- a/file.txt\n+++ b/file.txt\n@@ -1 +1 @@\n-old\n\\ No newline at end of file\n+new\n\\ No newline at end of file\n";

    await expect(createApplyPatchTool(workspace).execute({ patch }, new AbortController().signal))
      .rejects.toThrow(/newline/i);
    expect(readFileSync(path, "utf8")).toBe("old");
  });
});
