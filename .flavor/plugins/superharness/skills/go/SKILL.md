---
name: go
description: Use when the user gives a task goal to complete end-to-end under superharness discipline - drives the full autonomous workflow from goal to verified, reviewed, committed result
argument-hint: [task goal]
---

# Superharness Go — Autonomous Task Workflow

**Task goal:** $ARGUMENTS

If the goal above is empty, ask your human partner for the task goal and stop.

**Announce at start:** "Superharness engaged. Working on: <goal>."

You will now drive this goal to completion under the constraints in `HARNESS.md`
(in this plugin's root directory — read it now if it is not already in your context).
Work autonomously: only stop to ask when a decision genuinely belongs to your human
partner (destructive actions, ambiguous product choices). Everything else, decide and proceed.

## Phase 0 — Understand

1. Restate the goal in one sentence.
2. Explore the relevant code (Glob/Grep/Read) until you can name the files involved.
3. If the goal is ambiguous in a way that changes the architecture, ask ONE round of
   clarifying questions. Otherwise proceed with the most reasonable interpretation and
   note your assumptions in the plan.

## Phase 0.5 — Isolate

**REQUIRED SUB-SKILL:** `superharness:using-git-worktrees`

Set up an isolated workspace before changing anything. In a git project this
creates a worktree on a new branch **by default** (no consent prompt) so a run
that goes wrong can be discarded cleanly. If the project is not a git repo, or
worktree creation fails, work in place — never block. Everything after this
(plan, trace, implementation, commits) happens in whatever workspace this leaves.

## Phase 1 — Plan

**REQUIRED SUB-SKILL:** `superharness:writing-plans`

- For any goal needing 3+ steps, write the plan to `.claude/superharness/plans/YYYY-MM-DD-<slug>.md`
  (create the folder if missing).
- Bite-sized tasks, 2–5 minutes each. Every code step shows the actual code.
  Every task follows the TDD step sequence: failing test → verify RED → minimal
  implementation → verify GREEN → commit.
- Trivial goals (1–2 steps) may skip the plan file but NOT the TDD cycle.
- Create one TodoWrite/Task item per plan task and keep statuses current.
- **Ralph tracking is already auto-started — you only enrich it.** The moment this
  `/superharness:go` prompt was submitted, the UserPromptSubmit hook bootstrapped the
  ralph state under `.claude/superharness/ralph/`: it ran `Set-RalphCurrentTask` to
  write the `.current-task` pointer (the single active-task marker), seeded an empty
  `task.json`, and opened `trace.jsonl` with a `task:started` event. Dot-source
  `.claude/superharness/plugins/superharness/scripts/ralph-lib.ps1` first.
  - **Fallback — guarantee the files exist.** Check `Get-RalphCurrentTask -Root <project>`.
    If it returns `$null` the hook did NOT fire (a brand-new session is needed to register
    hooks, or this runner skips UserPromptSubmit for slash commands). In that case
    bootstrap it yourself NOW, as the very first action, so the runtime files appear under
    `.claude/superharness/ralph/` regardless:
    `Start-RalphTask -Root <project> -TaskId '<YYYY-MM-DD-slug>' -Goal '<goal>'`.
    If it already returns a task id, the hook handled it — do not recreate.
  - Then **enrich** the (now-present) state:
  - `Initialize-RalphTasks -Root <project> -Tasks @(@{ id=1; name='scaffold lib' }, @{ id=2; name='add ledger' }) -Phase 'plan' -SprintTotal <N>`
    — replace the empty list in `.claude/superharness/ralph/task.json` with the plan's
    task list (each `pending`). **Each entry MUST be a hashtable with `id` and `name`
    keys** — one per plan task. Passing bare strings (e.g. `@('scaffold','ledger')`)
    silently produces empty `{id:null, name:""}` rows, because the function reads
    `$t.id` / `$t.name` off each element. Set `-SprintTotal` to the task count.
  - `Add-RalphTrace -Root <project> -Phase 'plan' -Event 'plan:done' -Detail '<one-line plan summary>'`
    — append to the `.claude/superharness/ralph/trace.jsonl` execution ledger.
  The Stop hook records a `round` heartbeat each round while `.current-task` exists.
  Track **one active go task per project** at a time: `.current-task` is the single
  active-task marker, so do not run concurrent `go` tasks in the same project (a new
  go invocation auto-repoints the pointer to a new task).

## Phase 2 — Implement (TDD, no exceptions)

**REQUIRED SUB-SKILLS:** `superharness:subagent-driven-development` (for plans
with multiple independent tasks) and `superharness:test-driven-development`.

- **Multi-task plan:** delegate to `superharness:subagent-driven-development` —
  it dispatches a fresh subagent per task so this main context stays on plan and
  review. Each subagent does TDD and commits; you coordinate and handle BLOCKED.
- **Trivial goal (1–2 steps) or tightly-coupled tasks:** implement inline here
  with `superharness:test-driven-development` (no subagent overhead).

Either way, every task follows TDD with no exceptions:

1. **RED** — write the failing test first. Run it. Confirm it fails for the expected reason.
2. **GREEN** — write the minimal implementation. Run the test. Confirm it passes.
3. **REFACTOR** — clean up while keeping tests green.
4. **Commit** with a descriptive message.

If implementation code was written before its test: delete it, write the test, start over.
If anything behaves unexpectedly, switch to `superharness:systematic-debugging` —
no guess-and-patch fixes.

> Ralph trace note: at each task boundary, record execution events with
> `Add-RalphTrace -Root <project> -Phase 'implement' -Event '<task-id>:<red|green|commit>' -Detail '<short>'`,
> and flip status with `Set-RalphTaskStatus -Root <project> -Id <task-id> -Status in_progress|done`.
> Implementer subagents do not write trace markers; the main agent records them. The
> Stop hook independently appends a `round` heartbeat each round as a backstop.

## Phase 3 — Verify

**REQUIRED SUB-SKILL:** `superharness:verification-before-completion`

- Run the FULL test suite, not just the new tests. Paste actual output.
- **Record the verification + auto-retry (cap 5).** After running the FULL suite:
  - All green → `Add-RalphTrace -Root <project> -Phase 'verify' -Event 'verify:success' -Detail '<test cmd>'`,
    then `Set-RalphTaskStatus` the task to `done` and `Reset-RalphRetry -Root <project>`.
  - One or more failing → `Add-RalphTrace -Root <project> -Phase 'verify' -Event 'verify:failure' -Detail '<failing test + assertion>'`,
    then `Add-RalphRetry -Root <project>`. If `Test-RalphRetryExhausted -Root <project>`
    is true (the counter hit the cap of 5), **stop and report** — do not loop forever.
    Otherwise **automatically retry in this same run**: go back to Phase 2 via
    `superharness:systematic-debugging` (reproduce → root cause → fix → re-verify). This
    is an autonomous retry loop, not a blind re-run, and it does not pause to ask.
- Run linters/builds the project defines.
- Never report partial success as success.

## Phase 4 — Review

**REQUIRED SUB-SKILL:** `superharness:requesting-code-review`

- Dispatch a code-reviewer subagent over the change (base SHA → head SHA) using the
  template in `superharness:requesting-code-review`.
- Fix Critical and Important issues (each fix goes through the TDD cycle again).
  Note Minor issues in the final report.

## Phase 5 — Report

Deliver a final summary containing:

- What was built/changed and where (file paths)
- Evidence: test commands run and their actual results
- Review outcome and what was fixed
- Assumptions made and any noted Minor issues / follow-ups

**Close the trace.** On final completion, record the terminal event and clear the
active marker: `Add-RalphTrace -Root <project> -Phase 'done' -Event 'task:completed' -Detail '<summary>'`
(or `task:failed` / `task:abandoned`), mark the remaining tasks `done` via
`Set-RalphTaskStatus`, and remove `.claude/superharness/ralph/.current-task` so the Stop hook
stops recording. The full execution history stays in `.claude/superharness/ralph/trace.jsonl`
(plus the per-round Stop-hook heartbeats) for cold-start resume via `Get-RalphResumeContext`.

## Red Flags

| Thought | Reality |
|---------|---------|
| "The goal is simple, skip the plan" | Fine — but never skip TDD or verification. |
| "Tests after coding just this once" | No. RED first, always. |
| "Full suite takes too long" | Run it anyway. That's the evidence. |
| "Review is overkill here" | Multi-file or behavior-changing work gets reviewed. |
