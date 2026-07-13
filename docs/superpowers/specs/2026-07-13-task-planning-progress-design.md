# Task Planning and Progress UI Design

## Purpose

Add a Claude Code-style planning workflow to `flavor-code`: complex work is planned before execution, task state is updated as work progresses, active operations update in place, and the terminal shows a restrained progress animation. The existing task DAG remains the mechanism for optional subagent delegation; it does not become the sole representation of the main agent's plan.

## Scope

This change includes:

- A main-agent task plan that is independent of subagent delegation.
- Model tools for replacing a plan and updating one task.
- System guidance that requires proactive planning for complex work.
- Model-visible and persisted task state.
- Stable task and tool identifiers in terminal state so running rows can be updated in place.
- One foreground activity row plus an expanded list for parallel subagent work.
- Spinner, elapsed-time, success, failure, and cancellation presentation.
- Unit and integration coverage for state transitions, event flow, persistence, and rendering.

This change does not include:

- A separate interactive plan mode or approval screen.
- A new subagent orchestration model.
- Percentage completion inferred from token counts.
- Copying the full Claude Code renderer or its application state architecture.

## Chosen Approach

Use a separate main-agent plan and reuse the existing `Task` DAG only when work should be delegated. This keeps planning useful for sequential work performed by the main agent and avoids forcing every plan item into a child-agent execution.

Two alternatives were rejected:

1. Extending the existing `Task` tool to serve as both plan storage and delegation. This would couple user-visible planning to subagent availability and make simple sequential plans unnecessarily expensive.
2. Splitting prompts into tasks with hard-coded application heuristics. This would be brittle across providers and duplicate reasoning already available to the model.

## Task Model

The main-agent plan uses this logical shape:

```ts
type PlanTaskStatus = "pending" | "in_progress" | "completed" | "failed" | "blocked" | "cancelled";

interface PlanTask {
  id: string;
  subject: string;
  activeForm: string;
  status: PlanTaskStatus;
  dependencies: string[];
  result?: string;
}

interface TaskPlan {
  tasks: PlanTask[];
}
```

`subject` is the stable imperative description shown when a task is not running. `activeForm` is the present-continuous description used by the activity indicator. IDs must be unique and dependencies must refer to known tasks without cycles.

Only one main-agent task may be `in_progress` at a time. Multiple existing DAG nodes may be `running` concurrently; those are displayed as parallel subagent rows and do not violate the single foreground-task rule.

## Planning Policy and Tools

Add two main-agent-only tools:

- `TaskPlan` replaces the current main-agent plan after validating IDs, dependencies, statuses, and the one-active-task invariant.
- `TaskUpdate` updates one task's status and optional result while preserving the rest of the plan.

Subagents cannot call either tool, matching the existing restriction on recursive task delegation.

The main system prompt instructs the model to create a plan before execution when a request has at least three distinct implementation or verification steps, contains multiple requested changes, or is otherwise non-trivial. Straightforward single-step and informational requests should execute directly. The prompt also requires:

- Marking a task `in_progress` before performing its work.
- Marking it `completed` immediately after successful verification.
- Using `failed`, `blocked`, or `cancelled` rather than claiming completion when work is incomplete.
- Including verification as a plan item for multi-step code changes.

The runtime remains the authority for schema validation and persistence. Prompt compliance is not trusted as the only correctness boundary.

## Runtime State and Event Flow

The production runtime owns the current main-agent plan alongside the existing subagent graph, states, and results. Every accepted `TaskPlan` or `TaskUpdate` mutation performs this sequence:

1. Validate the proposed state.
2. Replace the in-memory plan atomically.
3. Update the main agent's `ContextManager` task-state layer.
4. Persist the session document.
5. Emit a complete task snapshot to the session output.

The UI event contains a complete snapshot instead of a patch. This makes rendering deterministic when model, tool, and hook events arrive close together and allows the UI to recover from a missed intermediate update.

The snapshot includes the main plan, existing subagent graph states, and the foreground task ID. Subagent start, stop, and result hooks emit a new snapshot after their existing state mutation.

At session start or resume, the runtime emits the current snapshot if task state exists. Abandoned `in_progress` main tasks and `running` subagent tasks are normalized by recovery rules before display.

## Persistence and Context

Extend the existing session `tasks` object with an optional main-agent `plan`. Existing session version 1 documents without a plan remain valid. No migration is required for absent optional data.

The serialized task snapshot supplied to `ContextManager.updateTaskState()` contains concise task IDs, descriptions, dependencies, and states but excludes verbose command output. It is regenerated after every accepted mutation so subsequent model calls see current task state.

`/tasks` returns both the main-agent plan and existing DAG execution state.

## Transcript and In-Place Updates

Transcript status blocks gain a stable key and status metadata. Tool rows use the tool-call ID already present on `tool-start` and `tool-end` events:

```ts
type StatusBlock = {
  kind: "status";
  id: string;
  state: "running" | "completed" | "failed" | "cancelled";
  text: string;
};
```

On `tool-start`, the reducer inserts or replaces `tool:<call-id>`. On `tool-end`, it replaces that same block rather than appending another line. Text and unrelated status blocks retain chronological order.

Task snapshots are held as structured active-turn state rather than flattened log strings. The completed foreground task row remains in the transcript with its final glyph and text. A new active task gets its own stable row.

## Terminal Presentation

The active turn shows one foreground row derived from the single `in_progress` main task:

```text
⠋ Running tests… (4s)
```

When finished, the same row becomes a static result:

```text
✓ Run tests · done (8s)
```

Failures and cancellations use `×` and a concise suffix. Pending tasks use a dim bullet when the expanded list is visible. Concurrent subagent nodes appear beneath the foreground row only in the expanded task area.

The spinner uses the repository's existing `useAnimationFrame` support with a 120 ms glyph cadence. Elapsed time changes at one-second granularity. Animation is confined to the active bottom region so completed scrollback does not repaint and terminal ghosting risk stays bounded. Non-interactive output renders a static running glyph and no animation timer.

## Failure and Cancellation Rules

- Invalid plans or transitions return structured tool failures and leave the previous plan unchanged.
- A task cannot become `in_progress` while another main task is active.
- A task cannot become `completed` while any declared dependency is incomplete.
- A failed dependency allows dependent tasks to become `blocked`.
- Cancelling the active submission changes the active main task to `cancelled` unless the model already moved it to a terminal state.
- Tool failures update their existing tool row to `failed`.
- Subagent failures continue to use existing DAG propagation rules and also refresh the task snapshot.
- Persistence failure follows the existing session-save diagnostic path; the in-memory and visible state remain available for the current process.

## Testing Strategy

Implementation follows test-driven development. Tests cover:

- Plan schema validation, dependency validation, and the single-active-task invariant.
- Valid and invalid task transitions.
- Task tools being available only to the main agent.
- Context task-state refresh after plan mutations.
- Session persistence and backward-compatible resume.
- Snapshot emission after plan and subagent state changes.
- Tool `running` and terminal state replacing the same transcript block.
- Foreground selection and parallel subagent presentation.
- Static rendering for completed, failed, cancelled, and non-interactive states.
- Spinner frame and elapsed-time formatting as pure functions, without timing-sensitive sleeps.

Focused tests must pass after each TDD cycle. Final verification runs type checking, build, relevant UI/runtime tests, and the repository suite. Pre-existing unrelated suite failures must be reported separately rather than hidden or attributed to this feature.

## Acceptance Criteria

The feature is accepted when:

1. A complex prompt causes the main model to receive explicit planning instructions and the `TaskPlan`/`TaskUpdate` tools.
2. Creating a plan displays pending tasks before implementation work begins.
3. Starting work displays one animated foreground row using `activeForm`.
4. Completing or failing work updates the same row rather than appending a duplicate.
5. Parallel subagent work is visible in the expanded task area while the foreground row remains singular.
6. The current plan is visible to later model calls, `/tasks`, and resumed sessions.
7. Cancellation and failure never appear as successful completion.
8. Existing DAG scheduling and session documents without a main plan remain compatible.
