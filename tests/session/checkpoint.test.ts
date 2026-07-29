import { mkdtemp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { WorkspaceCheckpointStore } from "../../src/session/checkpoint.js";

describe("WorkspaceCheckpointStore", () => {
  it("deduplicates objects and restores files while preserving excluded state", async () => {
    const root = await mkdtemp(join(tmpdir(), "flavor-checkpoint-"));
    await mkdir(join(root, "src"));
    await mkdir(join(root, "node_modules"));
    await writeFile(join(root, "src", "a.ts"), "one");
    await writeFile(join(root, "node_modules", "keep.txt"), "dependency");
    const store = new WorkspaceCheckpointStore({ workspace: root });

    const first = await store.create("first");
    const second = await store.create("same");
    expect(first.files[0]?.digest).toBe(second.files[0]?.digest);

    await writeFile(join(root, "src", "a.ts"), "two");
    await writeFile(join(root, "src", "new.ts"), "new");
    await writeFile(join(root, "node_modules", "keep.txt"), "changed dependency");
    await store.restore(first.id);

    expect(await readFile(join(root, "src", "a.ts"), "utf8")).toBe("one");
    await expect(readFile(join(root, "src", "new.ts"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(root, "node_modules", "keep.txt"), "utf8")).toBe("changed dependency");
  });

  it("rejects symlinks instead of following them", async () => {
    const root = await mkdtemp(join(tmpdir(), "flavor-checkpoint-link-"));
    const outside = await mkdtemp(join(tmpdir(), "flavor-checkpoint-outside-"));
    await writeFile(join(outside, "secret.txt"), "secret");
    await symlink(outside, join(root, "link"), "junction");
    const store = new WorkspaceCheckpointStore({ workspace: root });

    await expect(store.create()).rejects.toThrow(/symbolic link/i);
  });
});
