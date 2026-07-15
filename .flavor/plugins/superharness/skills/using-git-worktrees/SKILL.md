---
name: using-git-worktrees
description: Use when starting feature work that needs isolation from the current workspace, or before executing an implementation plan - ensures an isolated workspace exists, preferring native worktree tools then git, and degrades to working in place when there is no git repo
---

# Using Git Worktrees

## Overview

Make engineering work happen in an isolated, disposable workspace so a run that
goes wrong can be thrown away cleanly. Prefer a native worktree tool; fall back
to a manual `git worktree`; degrade to working in place when the project is not
a git repo.

**Announce at start:** "Setting up an isolated workspace (using-git-worktrees)."

**superharness default:** `go` invokes this for autonomous, auto-committing runs,
so in a git project **create a worktree by default** — do not stop to ask for
consent. Honor an explicit user instruction to work in place if one was given.

## Step 0 — Detect existing isolation

```bash
GIT_DIR=$(cd "$(git rev-parse --git-dir 2>/dev/null)" 2>/dev/null && pwd -P)
GIT_COMMON=$(cd "$(git rev-parse --git-common-dir 2>/dev/null)" 2>/dev/null && pwd -P)
```

- If `git rev-parse` fails (**not a git repo**): announce "No git repo here —
  working in place." Skip to Step 3.
- If `GIT_DIR` != `GIT_COMMON`: you may already be in a linked worktree. Guard
  against submodules first:
  ```bash
  git rev-parse --show-superproject-working-tree 2>/dev/null
  ```
  If that prints a path you are in a submodule — treat it as a normal repo.
  Otherwise you are already isolated: report the path/branch and skip to Step 3.

## Step 1 — Create the isolated workspace

### 1a. Native worktree tool (preferred)

If a native worktree tool is available (a tool named like `EnterWorktree`, a
`/worktree` command, or a `--worktree` flag), use it and skip to Step 3. Native
tools place the directory, create the branch, and clean up for you. Using raw
`git worktree add` when a native tool exists creates state the harness can't see.

### 1b. Git worktree fallback

Only if no native tool is available:

```bash
branch="superharness/<short-task-slug>"
# Ensure the worktree directory is ignored before creating it:
git check-ignore -q .worktrees || { printf '\n.worktrees/\n' >> .gitignore; git add .gitignore && git commit -m "chore: ignore .worktrees"; }
git worktree add ".worktrees/$branch" -b "$branch"
cd ".worktrees/$branch"
```

**If `git worktree add` fails** (permission/sandbox denial): announce the
failure and **work in place** on the current branch, then continue to Step 3.

## Step 3 — Project setup

Auto-detect and run setup for whatever the project uses, e.g.:

```bash
[ -f package.json ]     && npm install
[ -f requirements.txt ] && pip install -r requirements.txt
[ -f Cargo.toml ]       && cargo build
[ -f go.mod ]           && go mod download
```

## Step 4 — Verify a clean baseline

Run the project's test command. If it passes, report ready. If it fails, report
the failures and ask whether to proceed or investigate — you must be able to tell
new breakage from pre-existing breakage.

```
Workspace ready at <path> (worktree | in place)
Baseline: <N> tests passing, 0 failing
```

## Red Flags

| Thought | Reality |
|---------|---------|
| "I'll `git worktree add` even though EnterWorktree exists" | Use the native tool. Raw git creates phantom state. |
| "No git, so I'm stuck" | No. Announce and work in place — never block. |
| "I'll just commit inside the worktree dir" | Verify `.worktrees` is gitignored first. |
| "Baseline tests fail, I'll start anyway" | Report and ask. You can't attribute breakage later. |
