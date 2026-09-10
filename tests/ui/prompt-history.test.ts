import { mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { PromptHistoryStore } from "../../src/ui/prompt-history.js";

describe("PromptHistoryStore", () => {
  it("persists a bounded history per workspace", async () => {
    const home = await mkdtemp(join(tmpdir(), "flavor-prompt-history-"));
    const workspace = join(home, "project");
    const store = new PromptHistoryStore({ home, workspace, maxEntries: 2 });

    await store.append("one");
    await store.append("two");
    await store.append("three");

    expect(await new PromptHistoryStore({ home, workspace, maxEntries: 2 }).load()).toEqual(["two", "three"]);
    expect(await new PromptHistoryStore({ home, workspace: join(home, "other") }).load()).toEqual([]);
    const directory = join(home, ".flavor-code", "history");
    const files = await readdir(directory);
    expect(files).toHaveLength(1);
    if (process.platform !== "win32") expect((await stat(join(directory, files[0]!))).mode & 0o777).toBe(0o600);
  });

  it("treats a missing or corrupt history as empty", async () => {
    const home = await mkdtemp(join(tmpdir(), "flavor-prompt-history-empty-"));
    const store = new PromptHistoryStore({ home, workspace: join(home, "project") });
    expect(await store.load()).toEqual([]);
    await store.append("valid");
    const directory = join(home, ".flavor-code", "history");
    const [file] = await readdir(directory);
    await writeFile(join(directory, file!), "{not json", "utf8");
    expect(await store.load()).toEqual([]);
  });

  it("trims appended entries, ignores blanks, and keeps concurrent appends ordered", async () => {
    const home = await mkdtemp(join(tmpdir(), "flavor-prompt-history-write-"));
    const store = new PromptHistoryStore({ home, workspace: join(home, "project") });
    await Promise.all([store.append("  first  "), store.append("   "), store.append("second")]);
    expect(await new PromptHistoryStore({ home, workspace: join(home, "project") }).load()).toEqual(["first", "second"]);
  });

  it("discards foreign documents and non-string entries", async () => {
    const home = await mkdtemp(join(tmpdir(), "flavor-prompt-history-foreign-"));
    const workspace = join(home, "project");
    const store = new PromptHistoryStore({ home, workspace });
    await store.append("kept");
    const directory = join(home, ".flavor-code", "history");
    const [file] = await readdir(directory);
    const path = join(directory, file!);
    const document = JSON.parse(await readFile(path, "utf8")) as { version: number; workspace: string; entries: unknown[] };

    document.entries.push(42, "   ", "tail");
    await writeFile(path, JSON.stringify(document), "utf8");
    expect(await store.load()).toEqual(["kept", "tail"]);

    await writeFile(path, JSON.stringify({ ...document, version: 99 }), "utf8");
    expect(await store.load()).toEqual([]);

    await writeFile(path, JSON.stringify({ ...document, workspace: join(home, "elsewhere") }), "utf8");
    expect(await store.load()).toEqual([]);
  });
});
