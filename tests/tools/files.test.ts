import { existsSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { createApplyPatchTool, createEditTool, createReadTool, createWriteTool } from "../../src/tools/files.js";
import { getToolPresentation } from "../../src/tools/types.js";

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

  it("Read truncates instead of rejecting when file exceeds maxBytes", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "flavor-files-"));
    const path = join(workspace, "growing.txt");
    writeFileSync(path, "a");
    const data = Buffer.from("abcdef");
    const requested: number[] = [];
    let position = 0;
    let closed = false;
    const tool = createReadTool(workspace, { openFile: async () => ({
      read: async (buffer, offset, length) => {
        requested.push(length);
        const bytesRead = Math.min(length, 2, data.length - position);
        data.copy(buffer, offset, position, position + bytesRead);
        position += bytesRead;
        return { bytesRead };
      },
      close: async () => { closed = true; },
    }) });

    const result = await tool.execute({ path, maxBytes: 3 }, new AbortController().signal);
    expect(result).toContain("[Truncated to 3 bytes");
    expect(result).toContain("abc");
    expect(requested).toEqual([4, 2]);
    expect(position).toBe(4);
    expect(closed).toBe(true);
  });

  it("Read closes its handle when a bounded read fails", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "flavor-files-"));
    const path = join(workspace, "file.txt");
    writeFileSync(path, "a");
    let closed = false;
    const tool = createReadTool(workspace, { openFile: async () => ({
      read: async () => { throw new Error("read failed"); },
      close: async () => { closed = true; },
    }) });

    await expect(tool.execute({ path, maxBytes: 3 }, new AbortController().signal)).rejects.toThrow("read failed");
    expect(closed).toBe(true);
  });

  it("Read rejects an unsafe maxBytes before opening a handle", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "flavor-files-"));
    const path = join(workspace, "file.txt");
    writeFileSync(path, "a");
    let opened = 0;
    let closed = 0;
    const tool = createReadTool(workspace, { openFile: async () => {
      opened += 1;
      return {
        read: async () => ({ bytesRead: 0 }),
        close: async () => { closed += 1; },
      };
    } });
    const maxBytes = Number.MAX_SAFE_INTEGER;

    await expect(tool.execute({ path, maxBytes }, new AbortController().signal)).rejects.toThrow();
    expect({ opened, closed }).toEqual({ opened: 0, closed: 0 });
    expect(tool.inputSchema.safeParse({ path, maxBytes }).success).toBe(false);
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

    const output = await createWriteTool(workspace).execute({ path, content: "new" }, new AbortController().signal);

    expect(readFileSync(path, "utf8")).toBe("new");
    expect(readdirSync(workspace).filter((name) => name.startsWith("file.txt.") && name.endsWith(".tmp"))).toEqual([]);
    expect(getToolPresentation(output)).toMatchObject({
      kind: "file-change", operation: "update", path, added: 1, removed: 1,
    });
  });

  it("Write presents a missing destination as a new all-added file", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "flavor-files-"));
    const path = join(workspace, "new.txt");

    const output = await createWriteTool(workspace).execute(
      { path, content: "alpha\nbeta\n" },
      new AbortController().signal,
    );

    expect(getToolPresentation(output)).toMatchObject({
      kind: "file-change", operation: "create", path, added: 2, removed: 0,
      lines: [
        { kind: "added", newLine: 1, text: "alpha" },
        { kind: "added", newLine: 2, text: "beta" },
      ],
    });
  });

  it("Edit attaches the exact changed line and surrounding context", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "flavor-files-"));
    const path = join(workspace, "file.txt");
    writeFileSync(path, "one\ntwo\nthree\nold\nfive\nsix\nseven\n");

    const output = await createEditTool(workspace).execute(
      { path, oldText: "old", newText: "new" },
      new AbortController().signal,
    );

    expect(getToolPresentation(output)).toMatchObject({
      operation: "update", path, added: 1, removed: 1,
    });
    expect(getToolPresentation(output)?.lines).toContainEqual({ kind: "removed", oldLine: 4, text: "old" });
    expect(getToolPresentation(output)?.lines).toContainEqual({ kind: "added", newLine: 4, text: "new" });
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

    const output = await createApplyPatchTool(workspace).execute({ patch }, new AbortController().signal);

    expect(readFileSync(path, "utf8")).toBe("new\n");
    expect(getToolPresentation(output)).toMatchObject({
      operation: "update", path, added: 1, removed: 1,
      lines: [
        { kind: "removed", oldLine: 1, text: "old" },
        { kind: "added", newLine: 1, text: "new" },
      ],
    });
  });

  it("ApplyPatch describes its exact unique context relocation", () => {
    const workspace = mkdtempSync(join(tmpdir(), "flavor-files-"));

    expect(createApplyPatchTool(workspace).description).toContain("unique exact context");
  });

  it("ApplyPatch relocates a hunk by unique exact context", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "flavor-files-"));
    const path = join(workspace, "file.txt");
    writeFileSync(path, "zero\none\ntwo\nthree\n");
    const patch = "--- a/file.txt\n+++ b/file.txt\n@@ -3,2 +3,2 @@\n-one\n+ONE\n two\n";

    const output = await createApplyPatchTool(workspace).execute({ patch }, new AbortController().signal);

    expect(readFileSync(path, "utf8")).toBe("zero\nONE\ntwo\nthree\n");
    expect(getToolPresentation(output)?.lines).toContainEqual({ kind: "removed", oldLine: 2, text: "one" });
    expect(getToolPresentation(output)?.lines).toContainEqual({ kind: "added", newLine: 2, text: "ONE" });
  });

  it("ApplyPatch relocates multiple hunks independently", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "flavor-files-"));
    const path = join(workspace, "file.txt");
    writeFileSync(path, "prefix\na\nold-a\nc\nmiddle\nd\nold-b\nf\n");
    const patch = [
      "--- a/file.txt", "+++ b/file.txt",
      "@@ -4,3 +4,3 @@", " a", "-old-a", "+new-a", " c",
      "@@ -9,3 +9,3 @@", " d", "-old-b", "+new-b", " f", "",
    ].join("\n");

    await createApplyPatchTool(workspace).execute({ patch }, new AbortController().signal);

    expect(readFileSync(path, "utf8")).toBe("prefix\na\nnew-a\nc\nmiddle\nd\nnew-b\nf\n");
  });

  it("ApplyPatch rejects ambiguous relocated context without writing", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "flavor-files-"));
    const path = join(workspace, "file.txt");
    const original = "same\nold\nsame\nx\nsame\nold\nsame\n";
    writeFileSync(path, original);
    const patch = "--- a/file.txt\n+++ b/file.txt\n@@ -4,3 +4,3 @@\n same\n-old\n+new\n same\n";

    await expect(createApplyPatchTool(workspace).execute({ patch }, new AbortController().signal))
      .rejects.toThrow(/hunk 1.*ambiguous.*lines 1, 5/i);
    expect(readFileSync(path, "utf8")).toBe(original);
  });

  it("ApplyPatch diagnoses an already-applied hunk", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "flavor-files-"));
    const path = join(workspace, "file.txt");
    writeFileSync(path, "zero\nnew\nend\n");
    const patch = "--- a/file.txt\n+++ b/file.txt\n@@ -2 +2 @@\n-old\n+new\n";

    await expect(createApplyPatchTool(workspace).execute({ patch }, new AbortController().signal))
      .rejects.toThrow(/hunk 1.*already applied.*line 2/i);
  });

  it("ApplyPatch reports expected and actual context on mismatch", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "flavor-files-"));
    const path = join(workspace, "file.txt");
    writeFileSync(path, "zero\nactual\nend\n");
    const patch = "--- a/file.txt\n+++ b/file.txt\n@@ -2 +2 @@\n-old\n+new\n";

    await expect(createApplyPatchTool(workspace).execute({ patch }, new AbortController().signal))
      .rejects.toThrow(/hunk 1.*declared line 2.*expected.*old.*actual/i);
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

  it("ApplyPatch rejects git mode metadata before a valid hunk", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "flavor-files-"));
    const path = join(workspace, "file.txt");
    writeFileSync(path, "old\n");
    const patch = [
      "diff --git a/file.txt b/file.txt",
      "old mode 100644",
      "new mode 100755",
      "--- a/file.txt",
      "+++ b/file.txt",
      "@@ -1 +1 @@",
      "-old",
      "+new",
      "",
    ].join("\n");

    await expect(createApplyPatchTool(workspace).execute({ patch }, new AbortController().signal))
      .rejects.toThrow(/unsupported|metadata/i);
    expect(readFileSync(path, "utf8")).toBe("old\n");
  });
});
