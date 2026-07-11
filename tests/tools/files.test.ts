import { existsSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

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
    expect(existsSync(`${path}.tmp`)).toBe(false);
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
});
