import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import { desktopGitDiff, desktopGitDiscard, desktopGitStage, desktopGitStatus, desktopGitUnstage } from "../../src/desktop/git-manager.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function repository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "flavor-desktop-git-")); roots.push(root);
  execFileSync("git", ["init", "--quiet", root]);
  return root;
}

describe("desktop git manager", () => {
  it("lists, previews, stages and unstages one untracked file", async () => {
    const root = await repository(); await writeFile(join(root, "hello.txt"), "hello\n", "utf8");
    expect((await desktopGitStatus(root)).files[0]).toMatchObject({ path: "hello.txt", untracked: true });
    expect(await desktopGitDiff(root, "hello.txt")).toBe("hello\n");
    expect((await desktopGitStage(root, "hello.txt")).files[0]?.staged).toBe(true);
    expect((await desktopGitUnstage(root, "hello.txt")).files[0]?.untracked).toBe(true);
  });

  it("rejects paths outside the project and can discard a listed untracked file", async () => {
    const root = await repository(); await writeFile(join(root, "scratch.txt"), "temporary", "utf8");
    await expect(desktopGitStage(root, "../outside.txt")).rejects.toThrow("变更列表");
    expect((await desktopGitDiscard(root, "scratch.txt")).files).toEqual([]);
  });
});
