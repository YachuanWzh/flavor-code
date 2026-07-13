# Task Planning and Progress UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add main-agent task planning, durable task-state events, in-place terminal status updates, and a Claude Code-style animated foreground activity row.

**Architecture:** A focused `task-plan` domain module validates plans and transitions. Production owns the plan, exposes main-only mutation tools, refreshes model context and session persistence, and emits complete snapshots. The transcript reducer performs keyed upserts, while a small activity component renders the current task without animating completed scrollback.

**Tech Stack:** TypeScript ESM, Zod 4, React 19, the vendored `claude-ink` renderer, Vitest, tsup.

## Global Constraints

- Work directly on `main`; do not create a worktree.
- Use TDD for every behavior change and observe each new test fail before implementation.
- Keep the existing `Task` DAG as optional subagent delegation, separate from the main-agent plan.
- Allow only one main-plan task in `in_progress`; concurrent subagent `running` states remain valid.
- Keep session version 1 backward compatible by making the main plan optional.
- Animate only active interactive UI; completed transcript and non-interactive output stay static.

---

### Task 1: Main-Agent Task Plan Domain

**Files:**
- Create: `src/agent/task-plan.ts`
- Create: `tests/agent/task-plan.test.ts`

**Interfaces:**
- Produces: `PlanTaskStatusSchema`, `PlanTaskSchema`, `TaskPlanSchema`, `TaskUpdateInputSchema`, `PlanTask`, `TaskPlan`, `TaskUpdateInput`, `updatePlanTask(plan, input)`, `normalizeAbandonedPlan(plan)`.
- Consumes: Zod only; later runtime and session tasks import these public symbols.

- [ ] **Step 1: Write failing schema and transition tests**

```ts
import { describe, expect, it } from "vitest";
import { TaskPlanSchema, normalizeAbandonedPlan, updatePlanTask } from "../../src/agent/task-plan.js";

const task = (id: string, status = "pending", dependencies: string[] = []) => ({
  id, subject: `Do ${id}`, activeForm: `Doing ${id}`, status, dependencies,
});

it("rejects cycles and more than one in-progress task", () => {
  expect(() => TaskPlanSchema.parse({ tasks: [task("a", "pending", ["b"]), task("b", "pending", ["a"])] })).toThrow();
  expect(() => TaskPlanSchema.parse({ tasks: [task("a", "in_progress"), task("b", "in_progress")] })).toThrow();
});

it("updates one task without mutating the previous plan", () => {
  const plan = TaskPlanSchema.parse({ tasks: [task("a"), task("b", "pending", ["a"])] });
  const next = updatePlanTask(plan, { taskId: "a", status: "in_progress" });
  expect(next.tasks[0]?.status).toBe("in_progress");
  expect(plan.tasks[0]?.status).toBe("pending");
});

it("blocks completion while dependencies are incomplete", () => {
  const plan = TaskPlanSchema.parse({ tasks: [task("a"), task("b", "pending", ["a"])] });
  expect(() => updatePlanTask(plan, { taskId: "b", status: "completed" })).toThrow(/dependency/i);
});

it("normalizes an abandoned active task to cancelled", () => {
  const plan = TaskPlanSchema.parse({ tasks: [task("a", "in_progress")] });
  expect(normalizeAbandonedPlan(plan).tasks[0]?.status).toBe("cancelled");
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npm exec vitest run -- tests/agent/task-plan.test.ts`

Expected: FAIL because `src/agent/task-plan.ts` does not exist.

- [ ] **Step 3: Implement strict schemas and immutable transitions**

```ts
export const PlanTaskStatusSchema = z.enum(["pending", "in_progress", "completed", "failed", "blocked", "cancelled"]);
export const PlanTaskSchema = z.object({
  id: z.string().trim().min(1),
  subject: z.string().trim().min(1),
  activeForm: z.string().trim().min(1),
  status: PlanTaskStatusSchema,
  dependencies: z.array(z.string().trim().min(1)),
  result: z.string().optional(),
}).strict();

export const TaskPlanSchema = z.object({ tasks: z.array(PlanTaskSchema) }).strict().superRefine(validatePlan);
export const TaskUpdateInputSchema = z.object({
  taskId: z.string().trim().min(1),
  status: PlanTaskStatusSchema,
  result: z.string().optional(),
}).strict();

export function updatePlanTask(plan: TaskPlan, input: TaskUpdateInput): TaskPlan {
  const index = plan.tasks.findIndex((task) => task.id === input.taskId);
  if (index < 0) throw new Error(`Unknown task: ${input.taskId}`);
  const tasks = plan.tasks.map((task, current) => current === index
    ? { ...task, status: input.status, ...(input.result === undefined ? {} : { result: input.result }) }
    : { ...task });
  const next = TaskPlanSchema.parse({ tasks });
  const updated = next.tasks[index]!;
  if (updated.status === "completed" && updated.dependencies.some((id) => next.tasks.find((task) => task.id === id)?.status !== "completed")) {
    throw new Error(`Task ${updated.id} has an incomplete dependency`);
  }
  return next;
}
```

Implement duplicate/unknown dependency and cycle checks using the same topological approach as `src/agent/planner.ts`. `normalizeAbandonedPlan()` returns a parsed copy with `in_progress` changed to `cancelled` and result `Execution was abandoned`.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `npm exec vitest run -- tests/agent/task-plan.test.ts tests/agent/planner.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the domain model**

```powershell
git add src/agent/task-plan.ts tests/agent/task-plan.test.ts
git commit -m "feat(agent): add main task plan state"
```

### Task 2: Backward-Compatible Session Persistence

**Files:**
- Modify: `src/session/store.ts`
- Modify: `tests/session/store.test.ts`

**Interfaces:**
- Consumes: `TaskPlanSchema` and `normalizeAbandonedPlan()` from Task 1.
- Produces: optional `SessionDocument.tasks.plan` that older version-1 documents may omit.

- [ ] **Step 1: Add failing persistence and recovery tests**

```ts
it("persists a main plan and cancels abandoned in-progress work on load", async () => {
  const root = await workspace();
  const store = new SessionStore({ workspace: root });
  const saved = document(root);
  saved.tasks.plan = { tasks: [{
    id: "inspect", subject: "Inspect code", activeForm: "Inspecting code",
    status: "in_progress", dependencies: [],
  }] };
  await store.save(saved);
  const loaded = await store.load(saved.sessionId);
  expect(loaded.tasks.plan?.tasks[0]).toMatchObject({ status: "cancelled", result: "Execution was abandoned" });
});

it("loads a version-1 document without a main plan", async () => {
  const root = await workspace();
  const store = new SessionStore({ workspace: root });
  await store.save(document(root));
  expect((await store.load("session-20260712")).tasks.plan).toBeUndefined();
});
```

- [ ] **Step 2: Run the session test and verify RED**

Run: `npm exec vitest run -- tests/session/store.test.ts`

Expected: FAIL because `plan` is rejected or absent from the inferred document type.

- [ ] **Step 3: Extend the schema and recovery normalization**

```ts
tasks: z.object({
  plan: TaskPlanSchema.optional(),
  graph: TaskGraphSchema.optional(),
  states: z.record(z.string(), StateSchema),
  results: z.record(z.string(), SubagentResultSchema),
}).strict(),
```

Return `tasks: { ...document.tasks, ...(plan === undefined ? {} : { plan: normalizeAbandonedPlan(plan) }), states, results }` from recovery.

- [ ] **Step 4: Verify session tests pass**

Run: `npm exec vitest run -- tests/session/store.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit persistence support**

```powershell
git add src/session/store.ts tests/session/store.test.ts
git commit -m "feat(session): persist main task plans"
```

### Task 3: Runtime Tools, Context, and Snapshot Events

**Files:**
- Create: `src/agent/task-tools.ts`
- Create: `tests/agent/task-tools.test.ts`
- Modify: `src/agent/types.ts`
- Modify: `src/harness/local.ts`
- Modify: `src/ui/session.ts`
- Modify: `src/production.ts`
- Modify: `tests/cli/production.test.ts`

**Interfaces:**
- Produces: `TaskSnapshot`, agent event `{ type: "tasks"; snapshot: TaskSnapshot }`, `createTaskPlanTools(options)`, and main-only `TaskPlan` and `TaskUpdate` tools.
- Consumes: task-plan domain, existing `ContextManager.updateTaskState()`, existing DAG hooks and session persistence.

- [ ] **Step 1: Add failing production tests for tools and snapshots**

```ts
it("creates and updates plans through main planning tools", async () => {
  let plan: TaskPlan | undefined;
  const published: TaskPlan[] = [];
  const tools = createTaskPlanTools({
    getPlan: () => plan,
    commit: async (next) => { plan = next; published.push(next); },
  });
  await tools[0]!.execute({ tasks: [{
    id: "inspect", subject: "Inspect code", activeForm: "Inspecting code",
    status: "in_progress", dependencies: [],
  }] }, new AbortController().signal);
  await tools[1]!.execute({ taskId: "inspect", status: "completed", result: "done" }, new AbortController().signal);
  expect(published.at(-1)?.tasks[0]).toMatchObject({ status: "completed", result: "done" });
});

it("does not expose planning tools to subagents", async () => {
  const child = harness.createSubagent(task("child"));
  expect(child.tools.map((tool) => tool.name)).not.toEqual(expect.arrayContaining(["Task", "TaskPlan", "TaskUpdate"]));
});
```

- [ ] **Step 2: Run the production test and verify RED**

Run: `npm exec vitest run -- tests/agent/task-tools.test.ts tests/harness/local.test.ts tests/cli/production.test.ts`

Expected: FAIL because task events and planning tools do not exist.

- [ ] **Step 3: Add event types and snapshot construction**

```ts
export interface TaskSnapshot {
  plan?: TaskPlan;
  subagents: { graph?: TaskGraph; states: Record<string, SubagentState> };
  foregroundTaskId?: string;
}

// AgentEvent member
| { type: "tasks"; snapshot: TaskSnapshot }
```

In production, maintain `let taskPlan = recovered?.tasks.plan`, build `taskSnapshot()`, serialize it into `harness.main.context.updateTaskState(...)`, persist it, and emit it after every accepted plan mutation and subagent hook transition. In `LocalHarness.createSubagent()`, filter all three main-only tools with `!new Set(["Task", "TaskPlan", "TaskUpdate"]).has(tool.name)`.

- [ ] **Step 4: Add the two main-only tool definitions and planning policy**

```ts
const taskPlanTool: ToolDefinition<unknown> = {
  name: "TaskPlan",
  description: "Create or replace the main-agent plan for complex multi-step work",
  inputSchema: TaskPlanSchema,
  paths: () => [],
  execute: async (input) => {
    taskPlan = TaskPlanSchema.parse(input);
    await publishTaskState();
    return taskPlan;
  },
};
```

Implement `TaskUpdate` using a strict `{ taskId, status, result? }` schema and `updatePlanTask()`. Add both only to the main harness tool set. Extend the system prompt with the exact three-step threshold, immediate transitions, verification-task requirement, and prohibition on false completion.

- [ ] **Step 5: Verify runtime and context tests pass**

Run: `npm exec vitest run -- tests/agent/task-tools.test.ts tests/harness/local.test.ts tests/cli/production.test.ts tests/context/manager.test.ts tests/agent/subagents.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit runtime integration**

```powershell
git add src/agent/task-tools.ts tests/agent/task-tools.test.ts src/agent/types.ts src/harness/local.ts src/ui/session.ts src/production.ts tests/cli/production.test.ts tests/harness/local.test.ts
git commit -m "feat(runtime): publish task planning progress"
```

### Task 4: Keyed Transcript Status Updates

**Files:**
- Modify: `src/ui/transcript.ts`
- Modify: `tests/ui/transcript.test.ts`

**Interfaces:**
- Consumes: task snapshot events and existing tool call IDs.
- Produces: keyed status blocks and `active.taskSnapshot` for terminal rendering.

- [ ] **Step 1: Replace the append-only expectation with failing keyed-upsert tests**

```ts
it("updates a tool status in place by call id", () => {
  let state = transcriptReducer(createTranscriptState(), { type: "submit", prompt: "run" });
  state = transcriptReducer(state, { type: "session", event: { type: "tool-start", id: "1", name: "Read", input: {} } });
  state = transcriptReducer(state, { type: "session", event: { type: "tool-end", id: "1", name: "Read", result: { ok: true, output: "ok" } } });
  expect(state.active?.blocks).toEqual([{ kind: "status", id: "tool:1", state: "completed", text: "✦ Read · done" }]);
});

it("stores the latest complete task snapshot", () => {
  const snapshot = { plan: { tasks: [] }, subagents: { states: {} } };
  let state = transcriptReducer(createTranscriptState(), { type: "submit", prompt: "plan" });
  state = transcriptReducer(state, { type: "session", event: { type: "tasks", snapshot } });
  expect(state.active?.taskSnapshot).toEqual(snapshot);
});
```

- [ ] **Step 2: Run transcript tests and verify RED**

Run: `npm exec vitest run -- tests/ui/transcript.test.ts`

Expected: FAIL because status blocks have no IDs and task events are ignored.

- [ ] **Step 3: Implement status upsert and task snapshot reduction**

```ts
function upsertStatus(state: TranscriptState, block: StatusBlock): TranscriptState {
  if (state.active === undefined) return state;
  const index = state.active.blocks.findIndex((item) => item.kind === "status" && item.id === block.id);
  const blocks = [...state.active.blocks];
  if (index < 0) blocks.push(block); else blocks[index] = block;
  return { ...state, active: { ...state.active, blocks, statusLines: blocks.filter(isStatus).map((item) => item.text) } };
}
```

Handle `{ type: "tasks" }` by replacing `active.taskSnapshot`. Preserve prose order and notice blocks with generated stable notice IDs.

- [ ] **Step 4: Verify reducer tests pass**

Run: `npm exec vitest run -- tests/ui/transcript.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit keyed transcript state**

```powershell
git add src/ui/transcript.ts tests/ui/transcript.test.ts
git commit -m "feat(ui): update running statuses in place"
```

### Task 5: Foreground Activity and Expanded Task Rendering

**Files:**
- Create: `src/ui/task-progress.tsx`
- Create: `tests/ui/task-progress.test.tsx`
- Modify: `src/ui/app.tsx`
- Modify: `tests/ui/app-render.test.tsx`

**Interfaces:**
- Produces: `TaskProgress`, `activityFrame(elapsedMs)`, `formatElapsed(elapsedMs)`.
- Consumes: `TaskSnapshot`, `useAnimationFrame`, `Box`, and `Text` from `claude-ink`.

- [ ] **Step 1: Write failing pure-function and render tests**

```ts
it("cycles spinner frames every 120ms", () => {
  expect(activityFrame(0)).toBe("⠋");
  expect(activityFrame(120)).not.toBe(activityFrame(0));
});

it("formats elapsed time at one-second granularity", () => {
  expect(formatElapsed(4_900)).toBe("4s");
});

it("renders one foreground activity and parallel subagent rows", () => {
  const output = renderTaskProgress(snapshotWithForegroundAndTwoSubagents());
  expect(output).toContain("Inspecting code");
  expect(output.match(/Inspecting code/g)).toHaveLength(1);
  expect(output).toContain("worker-a");
  expect(output).toContain("worker-b");
});
```

- [ ] **Step 2: Run the focused UI test and verify RED**

Run: `npm exec vitest run -- tests/ui/task-progress.test.tsx`

Expected: FAIL because the component and helpers do not exist.

- [ ] **Step 3: Implement animation helpers and the focused active component**

```tsx
const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
export const activityFrame = (elapsedMs: number): string => FRAMES[Math.floor(elapsedMs / 120) % FRAMES.length]!;
export const formatElapsed = (elapsedMs: number): string => `${Math.max(0, Math.floor(elapsedMs / 1000))}s`;

export function TaskProgress({ snapshot, interactive = true }: TaskProgressProps): React.JSX.Element | null {
  const [ref, elapsed] = useAnimationFrame(interactive ? 120 : null);
  const active = snapshot.plan?.tasks.find((task) => task.id === snapshot.foregroundTaskId);
  if (active === undefined) return null;
  return <Box ref={ref} flexDirection="column">
    <Text color="yellow">{interactive ? activityFrame(elapsed) : "·"} {active.activeForm} ({formatElapsed(elapsed)})</Text>
    <ParallelSubagentRows snapshot={snapshot} />
  </Box>;
}
```

Render terminal states with `✓`, `×`, or a dim bullet and never call `useAnimationFrame` from completed transcript rows.

- [ ] **Step 4: Integrate the component into the active turn and keep completed rows static**

Pass the active turn's snapshot through `TurnView`. Render `TaskProgress` once below the active blocks; render the final task state as static content after the plan reaches a terminal state.

- [ ] **Step 5: Verify UI tests pass**

Run: `npm exec vitest run -- tests/ui/task-progress.test.tsx tests/ui/transcript.test.ts tests/ui/app-render.test.tsx`

Expected: PASS. If the known missing Yoga native module prevents renderer tests from loading, keep pure reducer/helper tests green and record the existing infrastructure blocker without weakening assertions.

- [ ] **Step 6: Commit terminal progress UI**

```powershell
git add src/ui/task-progress.tsx src/ui/app.tsx tests/ui/task-progress.test.tsx tests/ui/app-render.test.tsx
git commit -m "feat(ui): animate foreground task progress"
```

### Task 6: Cancellation, Documentation, and Full Verification

**Files:**
- Modify: `src/ui/session.ts`
- Modify: `src/production.ts`
- Modify: `tests/cli/session.test.ts`
- Modify: `README.md`

**Interfaces:**
- Consumes: runtime plan mutation and snapshot publication from Task 3.
- Produces: cancellation normalization for an active foreground task and documented user behavior.

- [ ] **Step 1: Add a failing cancellation behavior test**

```ts
it("marks the active plan task cancelled when the submission is interrupted", async () => {
  const events: string[] = []; const outputs: string[] = [];
  const base = services(events, outputs);
  let cancelled = 0;
  base.cancelActiveTask = async () => { cancelled += 1; };
  base.run = async function* (_prompt, signal) {
    await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    yield { type: "error", error: { code: "cancelled", message: "cancelled" } };
  };
  const session = new FlavorSession(base); await session.start();
  const running = session.submit("complex work");
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(session.interrupt()).toBe("cancelled");
  await running;
  expect(cancelled).toBe(1);
});
```

- [ ] **Step 2: Run the session test and verify RED**

Run: `npm exec vitest run -- tests/cli/session.test.ts`

Expected: FAIL because interruption does not mutate main task state.

- [ ] **Step 3: Add a runtime cancellation callback and document behavior**

Expose `cancelActiveTask()` on `SessionServices`; call it in `FlavorSession.#runSubmission()` when the controller is aborted. It atomically moves the current `in_progress` task to `cancelled`, publishes the snapshot, and persists.

Add README text explaining automatic planning for complex work, the single foreground task, expanded parallel task rows, `/tasks`, and session resume behavior.

- [ ] **Step 4: Run focused regression tests**

Run: `npm exec vitest run -- tests/agent/task-plan.test.ts tests/session/store.test.ts tests/cli/production.test.ts tests/cli/session.test.ts tests/ui/transcript.test.ts tests/ui/task-progress.test.tsx`

Expected: PASS.

- [ ] **Step 5: Run final verification**

```powershell
npm run typecheck
npm run build
npm test
git diff --check
git status --short
```

Expected: typecheck and build exit 0; all feature-focused tests pass. Report any pre-existing full-suite failures separately with exact failing files and counts.

- [ ] **Step 6: Commit final integration and documentation**

```powershell
git add src/ui/session.ts src/production.ts tests/cli/session.test.ts README.md
git commit -m "feat: complete task planning progress workflow"
```
