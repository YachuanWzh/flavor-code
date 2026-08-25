import { readFile, rm } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

import { changeSummary, commit, fileHistory, git, isGitRepository, type GitHistoryEntry } from "../git/service.js";
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

export type DesktopGitReviewScope = "working" | "staged" | "commit" | "base" | "last-turn";

export async function desktopGitReviewDiff(workspace: string, input: {
  scope: DesktopGitReviewScope;
  target?: string;
  paths?: readonly string[];
}): Promise<string> {
  if (!(await isGitRepository(workspace))) throw new Error("Review requires a Git repository");
  const paths = [...new Set(input.paths ?? [])].slice(0, 200);
  for (const path of paths) safeWorkspacePath(workspace, path);
  const suffix = paths.length === 0 ? [] : ["--", ...paths];
  let args: string[];
  if (input.scope === "working") args = ["diff", "HEAD", "--no-ext-diff", "--no-color", ...suffix];
  else if (input.scope === "staged") args = ["diff", "--staged", "--no-ext-diff", "--no-color", ...suffix];
  else if (input.scope === "last-turn") args = ["diff", "HEAD", "--no-ext-diff", "--no-color", ...suffix];
  else {
    const target = safeGitTarget(input.target);
    args = input.scope === "commit"
      ? ["show", "--format=", "--no-ext-diff", "--no-color", target]
      : ["diff", `${target}...HEAD`, "--no-ext-diff", "--no-color"];
  }
  const result = await git(workspace, args, 30_000);
  if (!result.ok) throw failure("读取审查差异", result.stderr, result.stdout);
  return result.stdout.length > 240_000 ? `${result.stdout.slice(0, 240_000)}\n…[diff truncated]` : result.stdout || "（此范围没有差异）";
}

export function desktopGitHistory(workspace: string): Promise<GitHistoryEntry[]> {
  return fileHistory(workspace, undefined, 50);
}

/** Diff of the last completed assistant turn, based on immutable workspace checkpoints. */
export async function desktopLastTurnDiff(workspace: string, sessionId: string, paths: readonly string[] = []): Promise<string> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(sessionId)) throw new Error("Invalid session id");
  const requested = new Set(paths.map((path) => { safeWorkspacePath(workspace, path); return path.replaceAll("\\", "/"); }));
  try {
    const tree = JSON.parse(await readFile(resolve(workspace, ".flavor", "session-trees", sessionId, "tree.json"), "utf8")) as { leafId?: string | null; nodes?: Array<{ id: string; parentId: string | null; checkpointId: string }> };
    const leaf = tree.nodes?.find((node) => node.id === tree.leafId);
    const parent = leaf?.parentId == null ? undefined : tree.nodes?.find((node) => node.id === leaf.parentId);
    if (leaf === undefined || parent === undefined) return desktopGitReviewDiff(workspace, { scope: "last-turn", paths });
    const load = async (id: string) => {
      if (!/^checkpoint-[A-Za-z0-9-]+$/.test(id)) throw new Error("Invalid checkpoint id");
      return JSON.parse(await readFile(resolve(workspace, ".flavor", "checkpoints", "manifests", `${id}.json`), "utf8")) as { files: Array<{ path: string; digest: string }> };
    };
    const [before, after] = await Promise.all([load(parent.checkpointId), load(leaf.checkpointId)]);
    const oldFiles = new Map(before.files.map((file) => [file.path, file.digest]));
    const newFiles = new Map(after.files.map((file) => [file.path, file.digest]));
    const changed = [...new Set([...oldFiles.keys(), ...newFiles.keys()])].filter((path) => oldFiles.get(path) !== newFiles.get(path) && (requested.size === 0 || requested.has(path))).slice(0, 200);
    const object = async (digest: string | undefined) => {
      if (digest === undefined) return "";
      if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error("Invalid checkpoint object");
      const value = await readFile(resolve(workspace, ".flavor", "checkpoints", "objects", digest));
      return value.includes(0) ? "[binary content]" : value.toString("utf8");
    };
    const chunks = await Promise.all(changed.map(async (path) => wholeFileDiff(path, await object(oldFiles.get(path)), await object(newFiles.get(path)))));
    const result = chunks.join("\n");
    return result.length > 240_000 ? `${result.slice(0, 240_000)}\n…[diff truncated]` : result || "（上一个 assistant turn 没有文件变化）";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return desktopGitReviewDiff(workspace, { scope: "last-turn", paths });
    throw error;
  }
}

function wholeFileDiff(path: string, before: string, after: string): string {
  const oldLines = before.replace(/\n$/, "").split("\n"); const newLines = after.replace(/\n$/, "").split("\n");
  return [`diff --flavor a/${path} b/${path}`, `--- ${before === "" ? "/dev/null" : `a/${path}`}`, `+++ ${after === "" ? "/dev/null" : `b/${path}`}`, `@@ -1,${before === "" ? 0 : oldLines.length} +1,${after === "" ? 0 : newLines.length} @@`, ...(before === "" ? [] : oldLines.map((line) => `-${line}`)), ...(after === "" ? [] : newLines.map((line) => `+${line}`))].join("\n");
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

function safeGitTarget(value: string | undefined): string {
  const target = value?.trim();
  if (target === undefined || target.length === 0 || target.length > 256 || target.startsWith("-")
    || !/^[A-Za-z0-9][A-Za-z0-9._/@{}~^:-]*$/.test(target)) throw new Error("Invalid Git review target");
  return target;
}
