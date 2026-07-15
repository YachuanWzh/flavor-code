import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { execFileNoThrow } from "../utils/execFileNoThrow.js";

export type GoalIntent = "read_only" | "code_change" | "ambiguous";

export interface LoopWorkspace {
  root: string;
  mode: "current" | "worktree";
  branch?: string;
}

export type LoopWorkspaceResolution =
  | { kind: "ready"; workspace: LoopWorkspace }
  | { kind: "needs_human"; reason: string };

export interface PrepareLoopWorkspaceOptions {
  root: string;
  loopId: string;
  goal: string;
  signal?: AbortSignal;
}

const CODE_CHANGE = /\b(?:fix|implement|add|update|change|modify|refactor|build|create|remove|delete|write|migrate)\b|修复|实现|添加|更新|修改|重构|创建|删除|迁移/i;
const READ_ONLY = /\b(?:review|analy[sz]e|inspect|explain|research|investigate|audit|summari[sz]e|report)\b|调研|分析|审查|检查|解释|研究|总结|报告/i;

export function inferGoalIntent(goal: string): GoalIntent {
  if (CODE_CHANGE.test(goal)) return "code_change";
  if (READ_ONLY.test(goal)) return "read_only";
  return "ambiguous";
}

export async function prepareLoopWorkspace(options: PrepareLoopWorkspaceOptions): Promise<LoopWorkspaceResolution> {
  options.signal?.throwIfAborted();
  const root = resolve(options.root);
  const intent = inferGoalIntent(options.goal);
  if (intent === "read_only") return { kind: "ready", workspace: { root, mode: "current" } };

  const inside = await git(root, ["rev-parse", "--is-inside-work-tree"]);
  if (inside.code !== 0 || inside.stdout.trim() !== "true") {
    return { kind: "needs_human", reason: "Code-changing loop work requires a Git repository for isolation." };
  }
  const status = await git(root, ["status", "--porcelain"]);
  if (status.code !== 0) return { kind: "needs_human", reason: `Could not inspect Git status: ${status.stderr.trim() || status.error || "unknown error"}` };
  if (status.stdout.trim().length > 0) {
    return { kind: "needs_human", reason: "The workspace has uncommitted changes that a new worktree would omit." };
  }

  options.signal?.throwIfAborted();
  const worktrees = join(root, ".worktrees");
  const path = join(worktrees, `loop-${options.loopId}`);
  const branch = `loop/${options.loopId}`;
  try { await ensureWorktreeDirectoryIgnored(root); }
  catch (error) {
    return {
      kind: "needs_human",
      reason: `Could not configure local Git exclusion for loop worktrees: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  await mkdir(worktrees, { recursive: true });
  const created = await git(root, ["worktree", "add", "-b", branch, path, "HEAD"]);
  if (created.code !== 0) {
    return {
      kind: "needs_human",
      reason: `Could not create isolated Git worktree: ${created.stderr.trim() || created.error || "unknown error"}`,
    };
  }
  options.signal?.throwIfAborted();
  return { kind: "ready", workspace: { root: path, mode: "worktree", branch } };
}

function git(root: string, args: string[]) {
  return execFileNoThrow("git", ["-C", root, ...args], { timeout: 30_000, useCwd: false });
}

async function ensureWorktreeDirectoryIgnored(root: string): Promise<void> {
  const ignored = await git(root, ["check-ignore", "-q", ".worktrees/placeholder"]);
  if (ignored.code === 0) return;
  const commonDirectory = await git(root, ["rev-parse", "--git-common-dir"]);
  if (commonDirectory.code !== 0) throw new Error(commonDirectory.stderr.trim() || "Git common directory is unavailable");
  const gitDirectory = resolve(root, commonDirectory.stdout.trim());
  const infoDirectory = join(gitDirectory, "info");
  const excludePath = join(infoDirectory, "exclude");
  await mkdir(infoDirectory, { recursive: true });
  let existing = "";
  try { existing = await readFile(excludePath, "utf8"); }
  catch (error) {
    if (!(typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")) throw error;
  }
  if (existing.split(/\r?\n/).some((line) => line.trim() === "/.worktrees/")) return;
  await appendFile(excludePath, `${existing.length > 0 && !existing.endsWith("\n") ? "\n" : ""}/.worktrees/\n`, "utf8");
}
