import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { DesktopWorktreeManager } from "../../src/desktop/worktree-manager.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function repository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "flavor-worktree-repo-")); roots.push(root);
  execFileSync("git", ["init", "--quiet", root]);
  execFileSync("git", ["-C", root, "config", "user.email", "desktop@test.local"]);
  execFileSync("git", ["-C", root, "config", "user.name", "Desktop Test"]);
  await writeFile(join(root, "README.md"), "base\n", "utf8");
  execFileSync("git", ["-C", root, "add", "README.md"]);
  execFileSync("git", ["-C", root, "commit", "--quiet", "-m", "base"]);
  return root;
}

describe("DesktopWorktreeManager", () => {
  it("creates and lists an isolated task worktree with a Flavor branch", async () => {
    const root = await repository();
    const storage = await mkdtemp(join(tmpdir(), "flavor-worktree-store-")); roots.push(storage);
    const manager = new DesktopWorktreeManager({ repository: root, storage });

    const created = await manager.create("session-alpha");

    expect(created.mode).toBe("worktree");
    expect(created.branch).toMatch(/^flavor\/desktop-session-alpha-/);
    expect(created.path.startsWith(storage)).toBe(true);
    expect(await manager.list()).toEqual([expect.objectContaining({ id: created.id, dirty: false })]);
  });

  it("refuses to remove a dirty worktree until force is explicit", async () => {
    const root = await repository();
    const storage = await mkdtemp(join(tmpdir(), "flavor-worktree-store-")); roots.push(storage);
    const manager = new DesktopWorktreeManager({ repository: root, storage });
    const created = await manager.create("session-dirty");
    await writeFile(join(created.path, "scratch.txt"), "dirty", "utf8");

    await expect(manager.remove(created.id)).rejects.toThrow(/dirty/i);
    await expect(manager.remove(created.id, true)).resolves.toBeUndefined();
    expect(await manager.list()).toEqual([]);
  });

  it("hands committed task changes back with an explicit merge", async () => {
    const root = await repository();
    const storage = await mkdtemp(join(tmpdir(), "flavor-worktree-store-")); roots.push(storage);
    const manager = new DesktopWorktreeManager({ repository: root, storage });
    const created = await manager.create("handoff");
    await writeFile(join(created.path, "task.txt"), "done\n", "utf8");
    execFileSync("git", ["-C", created.path, "add", "task.txt"]);
    execFileSync("git", ["-C", created.path, "commit", "--quiet", "-m", "task result"]);

    await manager.merge(created.id);

    expect(execFileSync("git", ["-C", root, "show", "HEAD:task.txt"], { encoding: "utf8" })).toBe("done\n");
    expect((await manager.list())[0]?.merged).toBe(true);
  });
});
