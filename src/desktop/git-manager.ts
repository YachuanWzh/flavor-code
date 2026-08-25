import { readFile, rm } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

import { changeSummary, commit, git, isGitRepository } from "../git/service.js";
import type { DesktopGitStatus } from "./contracts.js";

function failure(action: string, stderr: string, stdout: string): Error {
  return new Error(`${action}失败：${(stderr.trim() || stdout.trim() || "未知 Git 错误").split("\n")[0]}`);
}

export async function desktopGitStatus(workspace: string): Promise<DesktopGitStatus> {
  if (!(await isGitRepository(workspace))) return { repository: false, branch: "", head: "", files: [] };
  const summary = await changeSummary(workspace);
  return {
    repository: true,
    branch: summary.branch,
    head: summary.head,
    files: summary.statusLines.map((line) => {
      const index = line[0] ?? " ";
      const worktree = line[1] ?? " ";
      return {
        path: line.slice(3).replace(/^.* -> /, ""),
        index,
        worktree,
        staged: index !== " " && index !== "?",
        unstaged: worktree !== " " && worktree !== "?",
        untracked: index === "?" && worktree === "?",
      };
    }),
  };
}

export async function desktopGitDiff(workspace: string, path: string, staged = false): Promise<string> {
  const status = await desktopGitStatus(workspace);
  const file = status.files.find((item) => item.path === path);
  if (file === undefined) throw new Error("该文件已不在变更列表中");
  if (file.untracked) {
    const target = safeWorkspacePath(workspace, path);
    const value = await readFile(target, "utf8");
    return value.length > 120_000 ? `${value.slice(0, 120_000)}\n…[内容已截断]` : value;
  }
  const result = await git(workspace, ["diff", ...(staged ? ["--staged"] : []), "--no-ext-diff", "--no-color", "--", path]);
  if (!result.ok) throw failure("读取差异", result.stderr, result.stdout);
  return result.stdout || "（此区域没有差异）";
}

export async function desktopGitStage(workspace: string, path: string): Promise<DesktopGitStatus> {
  await assertListed(workspace, path);
  const result = await git(workspace, ["add", "--", path]);
  if (!result.ok) throw failure("暂存", result.stderr, result.stdout);
  return desktopGitStatus(workspace);
}

export async function desktopGitUnstage(workspace: string, path: string): Promise<DesktopGitStatus> {
  const file = await assertListed(workspace, path);
  if (!file.staged) return desktopGitStatus(workspace);
  const head = await git(workspace, ["rev-parse", "--verify", "HEAD"]);
  const result = head.ok
    ? await git(workspace, ["restore", "--staged", "--", path])
    : await git(workspace, ["rm", "--cached", "--", path]);
  if (!result.ok) throw failure("取消暂存", result.stderr, result.stdout);
  return desktopGitStatus(workspace);
}

export async function desktopGitDiscard(workspace: string, path: string): Promise<DesktopGitStatus> {
  const file = await assertListed(workspace, path);
  if (file.untracked) await rm(safeWorkspacePath(workspace, path), { recursive: false, force: false });
  else {
    const result = await git(workspace, ["restore", "--worktree", "--", path]);
    if (!result.ok) throw failure("还原", result.stderr, result.stdout);
  }
  return desktopGitStatus(workspace);
}

export async function desktopGitCommit(workspace: string, message: string) {
  return { result: await commit(workspace, message), status: await desktopGitStatus(workspace) };
}

async function assertListed(workspace: string, path: string) {
  const file = (await desktopGitStatus(workspace)).files.find((item) => item.path === path);
  if (file === undefined) throw new Error("该文件已不在变更列表中");
  safeWorkspacePath(workspace, path);
  return file;
}

function safeWorkspacePath(workspace: string, path: string): string {
  if (isAbsolute(path)) throw new Error("Git 文件路径必须是项目内的相对路径");
  const root = resolve(workspace);
  const target = resolve(root, path);
  const child = relative(root, target);
  if (child === "" || child.startsWith("..") || isAbsolute(child)) throw new Error("拒绝访问项目之外的路径");
  return target;
}
