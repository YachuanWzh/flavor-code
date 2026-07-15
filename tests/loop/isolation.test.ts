import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

import { inferGoalIntent, prepareLoopWorkspace } from "../../src/loop/isolation.js";

const exec = promisify(execFile);

async function gitRepository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "flavor-loop-git-"));
  await exec("git", ["init"], { cwd: root });
  await exec("git", ["config", "user.email", "loop@example.com"], { cwd: root });
  await exec("git", ["config", "user.name", "Loop Test"], { cwd: root });
  await writeFile(join(root, "README.md"), "base\n");
  await exec("git", ["add", "README.md"], { cwd: root });
  await exec("git", ["commit", "-m", "base"], { cwd: root });
  return root;
}

describe("loop isolation", () => {
  it("classifies read-only, code-changing, and ambiguous goals conservatively", () => {
    expect(inferGoalIntent("review the authentication design")).toBe("read_only");
    expect(inferGoalIntent("调研并分析当前架构")).toBe("read_only");
    expect(inferGoalIntent("fix all type errors")).toBe("code_change");
    expect(inferGoalIntent("实现登录功能")).toBe("code_change");
    expect(inferGoalIntent("make the project better")).toBe("ambiguous");
  });

  it("uses the current workspace for a read-only goal without Git", async () => {
    const root = await mkdtemp(join(tmpdir(), "flavor-loop-readonly-"));
    await expect(prepareLoopWorkspace({ root, loopId: "read-only", goal: "analyze architecture" }))
      .resolves.toEqual({ kind: "ready", workspace: { root, mode: "current" } });
  });

  it("requires human help for code-changing work outside Git", async () => {
    const root = await mkdtemp(join(tmpdir(), "flavor-loop-nongit-"));
    await expect(prepareLoopWorkspace({ root, loopId: "change", goal: "fix the app" }))
      .resolves.toMatchObject({ kind: "needs_human", reason: expect.stringMatching(/Git repository/i) });
  });

  it("creates a dedicated worktree and branch for code-changing work", async () => {
    const root = await gitRepository();
    const result = await prepareLoopWorkspace({ root, loopId: "feature-one", goal: "implement feature one" });
    expect(result).toMatchObject({
      kind: "ready",
      workspace: {
        root: join(root, ".worktrees", "loop-feature-one"),
        mode: "worktree",
        branch: "loop/feature-one",
      },
    });
    if (result.kind !== "ready") throw new Error(result.reason);
    expect((await readFile(join(result.workspace.root, "README.md"), "utf8")).replace(/\r\n/g, "\n")).toBe("base\n");
    const { stdout } = await exec("git", ["branch", "--show-current"], { cwd: result.workspace.root });
    expect(stdout.trim()).toBe("loop/feature-one");
    const baseStatus = await exec("git", ["status", "--porcelain"], { cwd: root });
    expect(baseStatus.stdout.trim()).toBe("");
  });

  it("does not isolate from a dirty base that would omit user changes", async () => {
    const root = await gitRepository();
    await writeFile(join(root, "README.md"), "dirty\n");
    await expect(prepareLoopWorkspace({ root, loopId: "dirty", goal: "fix the app" }))
      .resolves.toMatchObject({ kind: "needs_human", reason: expect.stringMatching(/uncommitted/i) });
  });
});
