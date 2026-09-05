// Minimal git runner used by the native git features (/commit, /review,
// GitHistory). Uses `git -C <workspace>` so the process cwd never matters.

import { execFileNoThrow } from "../utils/execFileNoThrow.js";

export interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number;
}

export async function git(workspace: string, args: readonly string[], timeoutMs = 30_000, signal?: AbortSignal): Promise<GitResult> {
  signal?.throwIfAborted();
  const result = await execFileNoThrow("git", ["-C", workspace, ...args], { timeout: timeoutMs, useCwd: false, ...(signal === undefined ? {} : { signal }) });
  signal?.throwIfAborted();
  return { ok: result.code === 0, stdout: result.stdout, stderr: result.stderr, code: result.code };
}

export async function isGitRepository(workspace: string, signal?: AbortSignal): Promise<boolean> {
  const result = await git(workspace, ["rev-parse", "--is-inside-work-tree"], 2_000, signal);
  return result.ok && result.stdout.trim() === "true";
}

function gitFailure(result: GitResult, action: string): Error {
  const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.code}`;
  return new Error(`git ${action} failed: ${detail.split("\n")[0]}`);
}

export interface GitChangeSummary {
  branch: string;
  head: string;
  /** porcelain v1 lines, e.g. `M  src/a.ts`. */
  statusLines: readonly string[];
  stagedFiles: readonly string[];
  unstagedFiles: readonly string[];
  untrackedFiles: readonly string[];
}

/** Snapshot of the working tree used to drive /commit decisions. */
export async function changeSummary(workspace: string): Promise<GitChangeSummary> {
  const branch = await git(workspace, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const head = await git(workspace, ["rev-parse", "--short", "HEAD"]);
  const status = await git(workspace, ["status", "--porcelain"]);
  if (!status.ok) throw gitFailure(status, "status");
  const statusLines = status.stdout.split("\n").map((line) => line.trimEnd()).filter((line) => line.length > 0);
  const stagedFiles: string[] = [];
  const unstagedFiles: string[] = [];
  const untrackedFiles: string[] = [];
  for (const line of statusLines) {
    const index = line[0] ?? " ";
    const worktree = line[1] ?? " ";
    const file = line.slice(3);
    if (index === "?" && worktree === "?") { untrackedFiles.push(file); continue; }
    if (index !== " " && index !== "?") stagedFiles.push(file);
    if (worktree !== " " && worktree !== "?") unstagedFiles.push(file);
  }
  return {
    branch: branch.ok ? branch.stdout.trim() : "HEAD",
    head: head.ok ? head.stdout.trim() : "unknown",
    statusLines,
    stagedFiles: [...new Set(stagedFiles)],
    unstagedFiles: [...new Set(unstagedFiles)],
    untrackedFiles,
  };
}

/** The staged diff (capped) plus a short stat summary for model prompts. */
export async function stagedDiff(workspace: string, maxChars = 96_000): Promise<{ diff: string; stat: string; truncated: boolean }> {
  const stat = await git(workspace, ["diff", "--staged", "--stat"]);
  const diff = await git(workspace, ["diff", "--staged", "--no-ext-diff", "--no-color"]);
  if (!diff.ok) throw gitFailure(diff, "diff --staged");
  const text = diff.stdout;
  return {
    diff: text.length > maxChars ? `${text.slice(0, maxChars)}\n…[diff truncated]` : text,
    stat: stat.stdout.trim(),
    truncated: text.length > maxChars,
  };
}

/** All uncommitted changes (staged + unstaged + untracked names) for review. */
export async function uncommittedDiff(workspace: string, maxChars = 96_000): Promise<{ diff: string; stat: string; untracked: readonly string[] }> {
  const stat = await git(workspace, ["diff", "HEAD", "--stat"]);
  const diff = await git(workspace, ["diff", "HEAD", "--no-ext-diff", "--no-color"]);
  if (!diff.ok && !diff.stderr.includes("unknown revision")) throw gitFailure(diff, "diff HEAD");
  const summary = await changeSummary(workspace);
  const text = diff.stdout;
  return {
    diff: text.length > maxChars ? `${text.slice(0, maxChars)}\n…[diff truncated]` : text,
    stat: stat.stdout.trim(),
    untracked: summary.untrackedFiles,
  };
}

export async function stageAll(workspace: string): Promise<void> {
  const result = await git(workspace, ["add", "-A"]);
  if (!result.ok) throw gitFailure(result, "add");
}

export async function commit(workspace: string, commitMessage: string): Promise<string> {
  // -F - reads the message from stdin so quoting never breaks multi-line text.
  const result = await execFileNoThrow("git", ["-C", workspace, "commit", "-F", "-"], {
    timeout: 30_000, useCwd: false, input: commitMessage,
  });
  if (result.code !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.code}`;
    throw new Error(`git commit failed: ${detail.split("\n")[0]}`);
  }
  const head = await git(workspace, ["log", "-1", "--pretty=%h %s"]);
  return head.stdout.trim() || "committed";
}

export interface GitHistoryEntry {
  hash: string;
  date: string;
  author: string;
  subject: string;
}

/** Commit history for the repository, or for one file when a path is given. */
export async function fileHistory(workspace: string, path: string | undefined, limit: number, signal?: AbortSignal): Promise<GitHistoryEntry[]> {
  const args = [
    "--literal-pathspecs", "log", `--max-count=${limit}`, "--date=short", "--pretty=format:%h%x1f%ad%x1f%an%x1f%s",
    ...(path === undefined ? [] : ["--follow", "--", path]),
  ];
  const result = await git(workspace, args, 15_000, signal);
  if (!result.ok) {
    const head = await git(workspace, ["rev-parse", "--verify", "HEAD"], 2_000, signal);
    if (!head.ok && await isGitRepository(workspace, signal)) return [];
    throw gitFailure(result, "log");
  }
  return result.stdout
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const [hash = "", date = "", author = "", ...subject] = line.split("\u001f");
      return { hash, date, author, subject: subject.join("\u001f") };
    });
}

/** Short branch@sha marker used to tag session checkpoints with git state. */
export async function gitMarker(workspace: string): Promise<string | undefined> {
  try {
    if (!(await isGitRepository(workspace))) return undefined;
    const summary = await changeSummary(workspace);
    if (summary.head === "unknown") return undefined;
    const dirty = summary.statusLines.length > 0 ? "-dirty" : "";
    return `${summary.branch}@${summary.head}${dirty}`;
  } catch {
    return undefined;
  }
}
