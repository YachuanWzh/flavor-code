# Loop Engineering Command Design

## Problem

Flavor already has a model-tool agent loop, task planning, subagents, session persistence, permissions, hooks, skills, and plugin commands. It does not have the outer control loop required by loop engineering: a durable goal that repeatedly runs an agent, verifies the result using host evidence, feeds failures into the next cycle, asks for more budget at explicit checkpoints, and stops in a named terminal state.

The command must stay simple. Users invoke `/loop <goal>` and configure safety defaults in `flavor.json`; they should not have to select verification commands, isolation strategy, cycle limits, or token limits on every invocation.

## Goals

- Add `/loop <goal>` as a reserved, built-in slash command with skill-like invocation semantics.
- Keep loop methodology and cycle prompting in a built-in Loop Skill while core runtime code owns orchestration, budget, persistence, isolation, verification, and terminal-state decisions.
- Infer verification and isolation from project facts at runtime, while making the resolved plan visible.
- Treat model completion claims only as requests for verification.
- Pause at cumulative cycle and token checkpoints and require user confirmation before increasing either allowance by one configured tranche.
- Persist enough state and evidence to explain why the loop continued or stopped.

## Non-goals

- Background scheduling, cron, webhooks, or a daemon.
- Automatic merge, push, release, deployment, or other irreversible external actions.
- Container isolation. The first implementation uses Git worktrees when safe and available.
- Arbitrary user-authored loop definitions or multiple concurrent loops in one interactive session.

## User Experience

The only start form is:

```text
/loop <goal>
```

`loop` is reserved and cannot be overridden by project skills or plugins. An empty goal returns concise usage guidance.

Before the first cycle, Flavor emits a resolved-loop summary containing the goal, inferred verifier commands, effective isolation, initial cycle checkpoint, and initial token checkpoint. Safe deterministic inference starts automatically. If verification cannot be inferred or required worktree isolation cannot be created, the loop asks the user instead of silently weakening the plan.

The existing task progress surface shows the cycle number, cumulative model tokens, next approval checkpoints, isolation mode, active verifier, and latest verification failure.

## Configuration

`flavor.json` gains a nested object:

```json
{
  "loop": {
    "maxCycles": 20,
    "maxTokens": 500000,
    "isolation": "auto"
  }
}
```

The values are approval tranche sizes rather than absolute lifetime maxima:

- `maxCycles` is the number of additional cycles authorized per approval.
- `maxTokens` is the number of additional cumulative model tokens authorized per approval.
- `isolation: "auto"` selects a Git worktree for code-changing work in a suitable Git repository and the current workspace for read-only work.

Configuration follows the existing global-to-project resolution order. Project configuration can override global defaults.

## Architecture

### Command dispatch

`parseSlashCommand` recognizes `/loop` and preserves the remaining text as the goal. `FlavorSession` dispatches it to a new `runLoop(goal, signal)` session service. This is a first-class core path, not a normal plugin command.

### Built-in Loop Skill

The built-in skill supplies methodology and prompt templates. It tells each worker cycle to inspect current state, make bounded progress toward the goal, use recent verifier evidence, and finish with a structured cycle report. The skill cannot mark the loop successful or extend a budget.

### LoopOrchestrator

The orchestrator owns one foreground run:

1. Resolve configuration and project facts.
2. Infer verification and isolation.
3. Create and persist `LoopState`.
4. Start a worker cycle with a fresh agent context.
5. Collect actual model usage and a structured worker report.
6. Execute host-owned verifier commands.
7. Persist evidence and decide `continue`, `succeeded`, `needs_human`, or a terminal failure.
8. Before another model call, enforce cycle and token approval checkpoints.

Each cycle receives only the goal, project instructions, compact loop memory, recent verifier evidence, and the built-in skill. It does not reuse an indefinitely growing worker conversation.

### Verification

Verifier discovery uses, in order:

1. Commands recorded by project initialization facts and `FLAVOR.md`.
2. Known package manifest scripts such as test, typecheck, lint, build, and smoke checks.
3. Language- and repository-specific deterministic checks already supported by Flavor.

The resolved verifier plan is persisted before execution. Commands run through the host and their exit codes and bounded outputs become evidence. A worker or verifier model may summarize evidence, but model judgment alone cannot produce `succeeded`.

If no trustworthy verifier is available initially, the loop runs one bounded verifier-discovery cycle so the worker can inspect the project and establish a meaningful project-native check. The host then re-runs inference and executes the discovered command. Obviously unconditional pass-through scripts are rejected; if discovery still produces no trustworthy verifier, the loop enters `needs_human`. It never treats a self-reported `TaskOutput.verification` field as proof.

### Isolation

Under `auto`:

- Read-only goals run in the current workspace.
- Code-changing goals in a suitable Git repository run in a dedicated worktree.
- If intent is ambiguous, Flavor selects worktree isolation.
- If a required worktree cannot be created, Flavor asks the user. It does not silently fall back to editing the current workspace.

All worker file and shell tools must bind to the resolved execution workspace. Verifier commands run against the same resulting tree, while verifier reasoning uses a fresh context and cannot approve its own code changes.

## Budget Checkpoints

The loop records cumulative input and output tokens from the main worker, subagents, compaction calls, and any model-based verification. Local commands do not consume token budget.

Let `cycleStep` be configured `maxCycles` and `tokenStep` be configured `maxTokens`. Initial checkpoints equal one step. When usage reaches or exceeds a checkpoint, the loop pauses at the next safe boundary before another model call.

The confirmation includes current usage, completed cycles, latest verification evidence, changed-file summary, and the next checkpoint. Approval increases only the reached checkpoint by one original step:

```text
tokenStep = 5,000,000
checkpoints = 5,000,000 -> 10,000,000 -> 15,000,000 -> ...
```

Cycle checkpoints behave identically: `20 -> 40 -> 60 -> ...` when `maxCycles` is 20.

Flavor never aborts a provider stream at an exact token boundary. It accounts for the completed call, then asks before the next call. Subagents scheduled within the current cycle are allowed to settle before the checkpoint decision; no new subagent or model call begins after exhaustion is known.

Approval is a user-only action and is recorded with the previous checkpoint, new checkpoint, cumulative usage, and timestamp. Rejection produces `budget_exhausted`. In non-interactive execution or if the session exits while waiting, the loop persists `needs_human`.

## State and Terminal Statuses

Loop state is stored separately from ordinary conversation history under `.flavor/loops/<loop-id>/`. The current snapshot is written atomically and an append-only event journal records cycles, usage, approvals, verification, and terminal decisions.

Statuses are:

- `running`
- `succeeded`
- `failed`
- `blocked`
- `cancelled`
- `budget_exhausted`
- `no_progress`
- `needs_human`

Repeated identical verifier failures with no material workspace change increment a no-progress counter. The loop stops as `no_progress` after three consecutive repetitions rather than spending another tranche indefinitely.

Ctrl+C aborts active model and tool work, checkpoints current state, and records `cancelled`. Process crashes leave a recoverable snapshot; recovery of paused/background execution is outside the initial command UX but the state format must not discard the evidence.

## Error Handling

- Provider retry remains owned by `AgentLoop`; the outer loop sees the final cycle outcome and accumulated usage.
- Invalid configuration fails before creating a worktree or invoking a model.
- Verifier command failure is ordinary loop evidence, not a runtime exception.
- Verifier launch failure, corrupt state, workspace escape, or persistence failure stops the loop as `failed`.
- Permission denial becomes `blocked` unless the user grants the requested operation through the existing permission flow.
- All terminal decisions include a concise reason and the latest evidence paths.

## Testing

Use TDD at four layers:

1. Command/config tests for `/loop <goal>`, reserved-name precedence, nested defaults, and validation.
2. Pure orchestrator tests with fake workers, usage, verifiers, approvals, repeated failures, and named terminal states.
3. Persistence and worktree tests for atomic state, event order, workspace binding, fallback refusal, cancellation, and recovery snapshots.
4. Production/UI integration tests for resolved summaries, progress, interactive budget confirmation, rejection, and non-interactive `needs_human`.

Complete verification runs focused loop tests, the full Vitest suite, typecheck, build, smoke installation, and `git diff --check`. Existing unrelated baseline failures must be reported separately rather than hidden.
