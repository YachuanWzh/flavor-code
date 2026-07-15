# Loop Engineering Command Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a foreground `/loop <goal>` command that repeatedly runs fresh worker cycles, verifies results using host evidence, persists state, automatically isolates code-changing work, and asks the user to extend cycle or token budget tranches.

**Architecture:** Add focused `src/loop/*` modules for domain state, persistence, verifier discovery, worktree isolation, built-in methodology, and orchestration. Integrate them through the existing slash dispatcher and production composition root; reuse `AgentLoop`, `QuestionBridge`, `createShellTool`, permissions, context construction, and session output without allowing model self-approval.

**Tech Stack:** TypeScript 7, Node.js 20+, Zod 4, React/Ink, Vitest 4, Git CLI.

## Global Constraints

- Work directly on `main` as explicitly requested; do not create a development worktree for this implementation.
- Do not commit or stage intermediate work. The user will review all changes together.
- Runtime `loop.isolation: "auto"` still creates a dedicated Git worktree for suitable code-changing loop goals.
- The start syntax is only `/loop <goal>`; there is no `start` subcommand and no per-invocation budget flag.
- `loop.maxCycles` and `loop.maxTokens` come from layered `flavor.json` configuration and are approval tranche sizes.
- Verification and isolation are inferred at runtime and the resolved plan is shown before the first cycle.
- A model completion claim triggers verification and never directly marks the loop successful.
- Cycle and token checkpoints grow by exactly one configured tranche after each explicit user approval.

---

### Task 1: Configure and parse `/loop <goal>`

**Files:**
- Modify: `src/config/schema.ts`
- Modify: `src/ui/commands.ts`
- Modify: `src/ui/session.ts`
- Modify: `tests/config/load.test.ts`
- Modify: `tests/ui/commands.test.ts`
- Modify: `tests/cli/session.test.ts`

**Interfaces:**
- Produces: `FlavorConfig["loop"]` with `{ maxCycles: number; maxTokens: number; isolation: "auto" }`.
- Produces: `SlashCommand` variant `{ name: "loop"; goal: string }`.
- Extends: `SessionServices` with `runLoop(goal: string, signal: AbortSignal): AsyncIterable<AgentEvent>`.

- [ ] Add failing config tests for nested defaults, global/project overrides, invalid non-positive values, and unknown isolation values.
- [ ] Add failing parser tests proving `/loop fix all tests` preserves `fix all tests`, `/loop` is invalid, and plugin/skill commands named `loop` cannot override it.
- [ ] Add a failing session test proving the goal is forwarded to `runLoop` and streamed events reach output.
- [ ] Run `npx vitest run tests/config/load.test.ts tests/ui/commands.test.ts tests/cli/session.test.ts` and confirm the new assertions fail.
- [ ] Add the schema:

```ts
loop: z.object({
  maxCycles: z.number().int().positive().max(10_000).default(20),
  maxTokens: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).default(500_000),
  isolation: z.literal("auto").default("auto"),
}).prefault({}),
```

- [ ] Reserve `loop`, parse all remaining text as `goal`, reject an empty goal with `Use /loop <goal>.`, and dispatch through `runLoop`.
- [ ] Run the three focused test files and make them pass.

### Task 2: Define loop state, tranche budgets, and durable storage

**Files:**
- Create: `src/loop/types.ts`
- Create: `src/loop/budget.ts`
- Create: `src/loop/store.ts`
- Create: `tests/loop/budget.test.ts`
- Create: `tests/loop/store.test.ts`

**Interfaces:**
- Produces: `LoopStatus`, `LoopState`, `LoopCycleEvidence`, `LoopVerificationEvidence`, and `LoopEvent` Zod schemas and inferred types.
- Produces: `budgetDecision(state): { kind: "allow" } | { kind: "confirm"; dimensions: ("cycles" | "tokens")[] }`.
- Produces: `extendBudget(state, dimensions, approvedAt): LoopState`.
- Produces: `LoopStore.create`, `LoopStore.save`, `LoopStore.append`, and `LoopStore.load` under `.flavor/loops/<loop-id>/`.

- [ ] Write budget tests for initial checkpoints, exact-boundary confirmation, overshoot confirmation at the next safe boundary, independent token/cycle extensions, repeated `5M -> 10M -> 15M` growth, and rejection state.
- [ ] Write store tests for atomic snapshot replacement, append-only ordered events, workspace ownership, bounded reads, invalid IDs, corrupt-state quarantine, and no symlink escape.
- [ ] Run `npx vitest run tests/loop/budget.test.ts tests/loop/store.test.ts` and confirm RED.
- [ ] Define strict schemas with statuses `running`, `succeeded`, `failed`, `blocked`, `cancelled`, `budget_exhausted`, `no_progress`, and `needs_human`.
- [ ] Implement pure budget functions so approval adds the original configured step rather than doubling the current checkpoint.
- [ ] Implement atomic state writes and serialized JSONL event appends with file mode `0600` and directory mode `0700`.
- [ ] Run the two focused test files and make them pass.

### Task 3: Infer and execute host-owned verification

**Files:**
- Create: `src/loop/verifier.ts`
- Create: `tests/loop/verifier.test.ts`

**Interfaces:**
- Produces: `inferVerificationPlan(workspace: string): Promise<VerificationPlan>`.
- Produces: `runVerificationPlan(plan, workspace, signal): Promise<LoopVerificationEvidence>`.
- Uses: `createShellTool(workspace)` so verifier execution retains bounded output and cancellation behavior.

- [ ] Write discovery tests for npm scripts in the order `test`, `typecheck`, `lint`, `build`, `smoke:install`; deduplicate commands also present in `FLAVOR.md`; and return `needsHumanReason` when no deterministic command exists.
- [ ] Write execution tests proving every command and real exit code are captured, failure stops later verifier commands, cancellation propagates, and output is bounded.
- [ ] Run `npx vitest run tests/loop/verifier.test.ts` and confirm RED.
- [ ] Implement manifest and `FLAVOR.md` discovery without executing file-provided shell text outside the supported command grammar.
- [ ] Execute commands through the existing shell tool with argument arrays and the resolved workspace.
- [ ] Run the focused verifier tests and make them pass.

### Task 4: Resolve code-change isolation and manage runtime worktrees

**Files:**
- Create: `src/loop/isolation.ts`
- Create: `tests/loop/isolation.test.ts`

**Interfaces:**
- Produces: `inferGoalIntent(goal): "read_only" | "code_change" | "ambiguous"`.
- Produces: `prepareLoopWorkspace({ root, loopId, goal, signal }): Promise<LoopWorkspace>`.
- `LoopWorkspace` exposes `{ root: string; mode: "current" | "worktree"; branch?: string; dispose(): Promise<void> }`.

- [ ] Write tests proving clearly read-only goals use the current root, code-changing and ambiguous goals require worktrees, non-Git read-only goals remain usable, and non-Git code-changing goals return a needs-human result.
- [ ] Add Git-backed tests proving worktrees are created below `.worktrees/loop-<id>`, branches use `loop/<id>`, paths are verified before cleanup, and failure never silently returns the original workspace.
- [ ] Run `npx vitest run tests/loop/isolation.test.ts` and confirm RED.
- [ ] Implement intent inference conservatively: unknown intent selects code-change isolation.
- [ ] Use `execFileNoThrow("git", [...])`, absolute verified paths, and native filesystem cleanup without destructive cross-shell composition.
- [ ] Run the focused isolation tests and make them pass.

### Task 5: Implement the built-in Loop Skill and pure orchestration state machine

**Files:**
- Create: `src/skills/builtin-loop.ts`
- Create: `src/loop/orchestrator.ts`
- Create: `tests/loop/orchestrator.test.ts`

**Interfaces:**
- Produces: `buildLoopCyclePrompt({ goal, cycle, memory, verification }): string`.
- Produces: `LoopWorker` callback returning `{ events: AsyncIterable<AgentEvent>; usage; report }` through orchestrator-controlled collection.
- Produces: `LoopOrchestrator.run(request): AsyncIterable<AgentEvent | LoopRuntimeEvent>`.
- Consumes injected `prepareWorkspace`, `runWorker`, `runVerifier`, `confirmBudget`, `store`, and `clock` dependencies for deterministic tests.

- [ ] Write prompt tests proving each cycle contains the immutable goal, current cycle, compact memory, latest host verifier evidence, and an instruction that the model cannot self-approve.
- [ ] Write orchestration tests for verifier success, verifier-failure feedback into a fresh next cycle, token aggregation, cycle aggregation, token and cycle confirmation, rejection, non-interactive `needs_human`, provider failure, cancellation, and persistence after every transition.
- [ ] Add no-progress tests proving three identical verifier failures with the same workspace fingerprint stop as `no_progress`.
- [ ] Run `npx vitest run tests/loop/orchestrator.test.ts` and confirm RED.
- [ ] Implement the smallest dependency-injected orchestrator state machine that makes the tests pass.
- [ ] Ensure no new worker or subagent call begins while a budget confirmation is pending.
- [ ] Run the focused orchestrator tests and make them pass.

### Task 6: Bind fresh worker cycles to production runtime and interactive approvals

**Files:**
- Modify: `src/production.ts`
- Modify: `src/harness/local.ts`
- Modify: `src/agent/types.ts`
- Modify: `src/ui/transcript.ts`
- Modify: `tests/cli/production.test.ts`
- Modify: `tests/ui/transcript.test.ts`

**Interfaces:**
- Produces loop runtime events for resolved plan, cycle start/end, verification start/end, budget checkpoint, and terminal state.
- Adds a production `runLoop` service that creates fresh loop-bound contexts and tools rooted at `LoopWorkspace.root`.
- Uses `QuestionBridge.ask` for interactive `Continue` / `Stop` decisions and persists `needs_human` when `approvalPolicy === "deny"`.

- [ ] Add production tests with fake adapters proving two failed verifier cycles use fresh model contexts and the next prompt contains host evidence from the prior cycle.
- [ ] Add tests proving all model `usage` events contribute to loop totals and a reached checkpoint asks exactly once before the next call.
- [ ] Add tests for approval extension, rejection, non-interactive `needs_human`, worktree-rooted tools, cancellation, and a final persisted event journal.
- [ ] Add transcript tests for one compact loop-progress block that updates rather than appending noisy rows.
- [ ] Run the focused production and transcript tests and confirm RED.
- [ ] Refactor production context/tool construction only as far as required to create fresh workspace-bound worker harnesses; preserve ordinary session behavior.
- [ ] Connect `QuestionBridge`, output events, and store lifecycle; make the focused tests pass.

### Task 7: Document the delivered command and verify the repository

**Files:**
- Modify: `README.md`
- Modify: `技术方案报告.md`
- Review: all files changed by Tasks 1-6

**Interfaces:**
- Documents: `/loop <goal>`, `loop` configuration, inferred verification/isolation, tranche approvals, terminal states, persistence paths, and current limitations.

- [ ] Replace roadmap statements that say `/loop` is unimplemented with the delivered architecture and command behavior.
- [ ] Add configuration and usage examples without exposing removed `start`, `--max-cycles`, `--max-tokens`, `--verify`, or `--isolation` syntax.
- [ ] Run all focused loop tests.
- [ ] Run `npm test` and record exact pass/fail counts.
- [ ] Run `npm run typecheck` and distinguish new errors from the known baseline errors.
- [ ] Run `npm run build`.
- [ ] Run `npm run smoke:install`.
- [ ] Run `git diff --check`, inspect `git diff --stat`, and inspect `git status --short`.
- [ ] Do not commit or stage; present the complete unstaged diff for user review.
