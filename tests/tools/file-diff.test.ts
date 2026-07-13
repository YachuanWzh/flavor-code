import { describe, expect, it } from "vitest";

interface DiffHunkInput {
  oldStart: number;
  newStart: number;
  lines: string[];
}

interface FileDiffModule {
  buildFileChangePresentation(
    path: string,
    before: string,
    after: string,
    operation: "create" | "update",
  ): {
    kind: "file-change";
    operation: "create" | "update" | "delete";
    path: string;
    added: number;
    removed: number;
    lines: Array<{
      kind: "context" | "removed" | "added" | "omitted";
      oldLine?: number;
      newLine?: number;
      text: string;
    }>;
  };
  buildPatchPresentation(
    path: string,
    created: boolean,
    hunks: readonly DiffHunkInput[],
  ): ReturnType<FileDiffModule["buildFileChangePresentation"]>;
}

async function loadFileDiff(): Promise<Partial<FileDiffModule>> {
  const path = "../../src/tools/file-diff.js";
  return import(path).catch(() => ({}));
}

describe("file diff presentation", () => {
  it("builds a numbered update with three surrounding context lines", async () => {
    const { buildFileChangePresentation } = await loadFileDiff();
    expect(typeof buildFileChangePresentation).toBe("function");
    if (buildFileChangePresentation === undefined) return;

    const before = ["one", "two", "three", "old", "five", "six", "seven"].join("\n");
    const after = ["one", "two", "three", "new", "five", "six", "seven"].join("\n");
    const preview = buildFileChangePresentation("notes.md", before, after, "update");

    expect(preview).toMatchObject({
      kind: "file-change",
      operation: "update",
      path: "notes.md",
      added: 1,
      removed: 1,
    });
    expect(preview.lines).toEqual([
      { kind: "context", oldLine: 1, newLine: 1, text: "one" },
      { kind: "context", oldLine: 2, newLine: 2, text: "two" },
      { kind: "context", oldLine: 3, newLine: 3, text: "three" },
      { kind: "removed", oldLine: 4, text: "old" },
      { kind: "added", newLine: 4, text: "new" },
      { kind: "context", oldLine: 5, newLine: 5, text: "five" },
      { kind: "context", oldLine: 6, newLine: 6, text: "six" },
      { kind: "context", oldLine: 7, newLine: 7, text: "seven" },
    ]);
  });

  it("renders a new file as added lines starting at one", async () => {
    const { buildFileChangePresentation } = await loadFileDiff();
    expect(typeof buildFileChangePresentation).toBe("function");
    if (buildFileChangePresentation === undefined) return;

    const preview = buildFileChangePresentation("new.txt", "", "alpha\nbeta\n", "create");

    expect(preview).toMatchObject({ operation: "create", added: 2, removed: 0 });
    expect(preview.lines).toEqual([
      { kind: "added", newLine: 1, text: "alpha" },
      { kind: "added", newLine: 2, text: "beta" },
    ]);
  });

  it("converts unified diff hunks without losing old and new line numbers", async () => {
    const { buildPatchPresentation } = await loadFileDiff();
    expect(typeof buildPatchPresentation).toBe("function");
    if (buildPatchPresentation === undefined) return;

    const preview = buildPatchPresentation("file.txt", false, [{
      oldStart: 10,
      newStart: 10,
      lines: [" keep", "-old", "+new", " tail"],
    }]);

    expect(preview).toMatchObject({ operation: "update", added: 1, removed: 1 });
    expect(preview.lines).toEqual([
      { kind: "context", oldLine: 10, newLine: 10, text: "keep" },
      { kind: "removed", oldLine: 11, text: "old" },
      { kind: "added", newLine: 11, text: "new" },
      { kind: "context", oldLine: 12, newLine: 12, text: "tail" },
    ]);
  });

  it("limits previews to 120 rows while keeping full change counts", async () => {
    const { buildFileChangePresentation } = await loadFileDiff();
    expect(typeof buildFileChangePresentation).toBe("function");
    if (buildFileChangePresentation === undefined) return;

    const after = Array.from({ length: 200 }, (_, index) => `line ${index + 1}`).join("\n");
    const preview = buildFileChangePresentation("large.txt", "", after, "create");

    expect(preview).toMatchObject({ added: 200, removed: 0 });
    expect(preview.lines).toHaveLength(120);
    expect(preview.lines.filter((line) => line.kind === "omitted")).toEqual([
      { kind: "omitted", text: "… 81 lines hidden" },
    ]);
    expect(preview.lines[0]).toMatchObject({ kind: "added", newLine: 1 });
    expect(preview.lines.at(-1)).toMatchObject({ kind: "added", newLine: 200 });
  });

  it("attaches presentation metadata without serializing it", async () => {
    const typesPath = "../../src/tools/types.js";
    const types = await import(typesPath) as Record<string, unknown>;
    expect(typeof types["withToolPresentation"]).toBe("function");
    expect(typeof types["getToolPresentation"]).toBe("function");
    if (typeof types["withToolPresentation"] !== "function" || typeof types["getToolPresentation"] !== "function") return;

    const output = { path: "notes.md", replacements: 1 };
    const presentation = { kind: "file-change", operation: "delete", path: "notes.md", added: 0, removed: 0, lines: [] };
    const attached = (types["withToolPresentation"] as (value: typeof output, preview: typeof presentation) => typeof output)(output, presentation);

    expect((types["getToolPresentation"] as (value: unknown) => unknown)(attached)).toEqual(presentation);
    expect(JSON.stringify(attached)).toBe('{"path":"notes.md","replacements":1}');
  });
});
