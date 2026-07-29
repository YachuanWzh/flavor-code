# Control Plane, Sandbox, and VS Code Integration Implementation Plan

> **For agentic workers:** Execute this plan task-by-task under the superharness:go workflow, Phase 2 (strict TDD per task). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver steering, reversible session history, SDK/RPC, eval/trace/replay, Docker sandboxing, and a VS Code client as working MVPs.

**Architecture:** `FlavorSession` owns delivery queues, while `AgentLoop` exposes a steering drain point after tool batches. A session-tree manager composes context snapshots with content-addressed workspace checkpoints. SDK, CLI RPC, eval, Electron, and VS Code all call the same production runtime; shell execution is routed through a local or Docker `ExecutionEnvironment`.

**Tech Stack:** TypeScript, Node.js streams/process/fs, Zod, Vitest, tsup, Electron, VS Code extension API, Docker CLI.

**User override:** Do not stage or commit. Commit steps from the generic skill are intentionally omitted.

**Completion:** Implemented and verified on 2026-07-30. The checklists below retain the original TDD execution outline.

---

### Task 1: Steering and follow-up queues

**Files:**
- Create: `src/agent/message-queue.ts`
- Modify: `src/agent/types.ts`
- Modify: `src/agent/loop.ts`
- Modify: `src/ui/session.ts`
- Modify: `src/production.ts`
- Modify: `src/desktop/contracts.ts`
- Modify: `src/desktop/runtime-controller.ts`
- Modify: `src/desktop/renderer/app.tsx`
- Test: `tests/agent/message-queue.test.ts`
- Test: `tests/agent/loop.test.ts`
- Test: `tests/cli/session.test.ts`
- Test: `tests/desktop/runtime-controller.test.ts`

- [ ] Write tests for ordered queue draining, one/all modes, clearing, and immutable snapshots.
- [ ] Run focused tests and confirm missing API failures.
- [ ] Implement `AgentMessageQueue`.
- [ ] Write an AgentLoop test proving steering is appended after tool results and before the next model request.
- [ ] Run it red, add `getSteeringMessages` to `AgentRunRequest`, then run green.
- [ ] Write FlavorSession tests for active steer, follow-up ordering, idle steer, and interrupt queue recovery.
- [ ] Run red, implement session methods and queue notices, then run green.
- [ ] Write desktop tests for busy submissions and queue snapshot projection.
- [ ] Run red, remove the busy submission rejection, wire explicit delivery intent, then run green.
- [ ] Run all affected agent/CLI/desktop tests.

### Task 2: Content-addressed workspace checkpoints

**Files:**
- Create: `src/session/checkpoint.ts`
- Test: `tests/session/checkpoint.test.ts`

- [ ] Write tests for Git file discovery, non-Git fallback, exclusions, digest deduplication, and symlink rejection.
- [ ] Run red and implement checkpoint creation with atomic manifest/object writes.
- [ ] Write tests for restore, deletion of managed post-checkpoint files, path traversal rejection, and abort safety.
- [ ] Run red and implement bounded restore.
- [ ] Refactor common atomic/path helpers while tests remain green.

### Task 3: Append-only session tree and rewind

**Files:**
- Create: `src/session/tree.ts`
- Modify: `src/ui/session.ts`
- Modify: `src/production.ts`
- Modify: `src/ui/commands.ts`
- Modify: `src/ui/slash-completion.ts`
- Test: `tests/session/tree.test.ts`
- Test: `tests/cli/session.test.ts`
- Test: `tests/ui/commands.test.ts`

- [ ] Write tests for root creation, child append, branch creation, leaf movement, persistence, and corrupted-tree rejection.
- [ ] Run red and implement the tree store.
- [ ] Write rewind/unrevert tests using real temporary files and context snapshots.
- [ ] Run red and implement the session history coordinator.
- [ ] Write slash-command parsing/dispatch tests for checkpoint/tree/rewind/unrevert/fork.
- [ ] Run red and wire production services, persistence, and user-facing output.
- [ ] Run all session, context, CLI, and production tests.

### Task 4: Stable trace and replay

**Files:**
- Create: `src/trace/schema.ts`
- Create: `src/trace/recorder.ts`
- Create: `src/trace/replay.ts`
- Modify: `src/production.ts`
- Test: `tests/trace/recorder.test.ts`
- Test: `tests/trace/replay.test.ts`

- [ ] Write schema and recorder tests for monotonic sequence, atomic append ordering, redaction, and permissions.
- [ ] Run red and implement the recorder.
- [ ] Write replay tests for event ordering, malformed records, session filtering, and zero provider calls.
- [ ] Run red and implement replay.
- [ ] Add an optional production runtime trace seam and verify normal callers are unchanged.

### Task 5: Public SDK

**Files:**
- Create: `src/sdk/index.ts`
- Modify: `package.json`
- Modify: `tsup.config.ts`
- Test: `tests/sdk/index.test.ts`

- [ ] Write an import-contract test for supported SDK exports and absence of Electron side effects.
- [ ] Run red and add the SDK entry point.
- [ ] Write a fake-provider runtime test using a temporary workspace.
- [ ] Run red and expose the minimal creation/type surface.
- [ ] Build the SDK bundle and verify package exports.

### Task 6: JSONL RPC server

**Files:**
- Create: `src/rpc/schema.ts`
- Create: `src/rpc/server.ts`
- Modify: `src/cli.tsx`
- Modify: `tsup.config.ts`
- Test: `tests/rpc/schema.test.ts`
- Test: `tests/rpc/server.test.ts`
- Test: `tests/cli/rpc.test.ts`

- [ ] Write schema tests for every command and unknown-field rejection.
- [ ] Run red and implement Zod command/response records.
- [ ] Write in-memory stream tests for malformed input, prompt acceptance, event streaming, concurrent steer, state, and shutdown.
- [ ] Run red and implement the RPC server with serialized writes.
- [ ] Write CLI routing tests and wire `--mode rpc`, `--workspace`, and `--trace`.
- [ ] Run focused RPC and CLI tests.

### Task 7: Eval runner

**Files:**
- Create: `src/eval/schema.ts`
- Create: `src/eval/runner.ts`
- Create: `src/eval/cli.ts`
- Modify: `src/cli.tsx`
- Test: `tests/eval/runner.test.ts`
- Test: `tests/eval/cli.test.ts`

- [ ] Write spec-validation tests for relative workspace resolution, command arrays, limits, and unknown fields.
- [ ] Run red and implement the schema.
- [ ] Write runner tests with injected runtime/execution environment for pass, fail, timeout, runtime error, and token budget.
- [ ] Run red and implement deterministic report generation.
- [ ] Write CLI output tests and register `flavor eval`.

### Task 8: ExecutionEnvironment and Docker sandbox

**Files:**
- Create: `src/execution/types.ts`
- Create: `src/execution/local.ts`
- Create: `src/execution/docker.ts`
- Create: `src/execution/factory.ts`
- Modify: `src/tools/shell.ts`
- Modify: `src/config/schema.ts`
- Modify: `src/production.ts`
- Test: `tests/execution/local.test.ts`
- Test: `tests/execution/docker.test.ts`
- Test: `tests/tools/shell.test.ts`
- Test: `tests/config/load.test.ts`

- [ ] Move existing shell behavior behind a wished-for `ExecutionEnvironment` API in tests.
- [ ] Run red, implement the local environment, and delegate Shell to it without changing results.
- [ ] Write Docker argv tests for default isolation, network opt-in, cwd mapping, limits, Windows mount paths, and injection-safe argument separation.
- [ ] Run red and implement Docker command construction/execution.
- [ ] Write fail-closed availability and cancellation tests.
- [ ] Run red and implement the factory/config integration.
- [ ] Run all tools, permissions, config, loop, and production tests.

### Task 9: VS Code RPC client and extension

**Files:**
- Create: `extensions/vscode/package.json`
- Create: `extensions/vscode/tsconfig.json`
- Create: `extensions/vscode/src/rpc-client.ts`
- Create: `extensions/vscode/src/prompts.ts`
- Create: `extensions/vscode/src/extension.ts`
- Create: `extensions/vscode/README.md`
- Modify: `package.json`
- Test: `tests/vscode/rpc-client.test.ts`
- Test: `tests/vscode/prompts.test.ts`

- [ ] Write stream-level RPC client tests for correlation, events, malformed server output, process exit, and disposal.
- [ ] Run red and implement a transport-injected client.
- [ ] Write prompt-builder tests for selection/path/line bounds and diagnostics truncation.
- [ ] Run red and implement bounded prompt builders.
- [ ] Implement activation commands, output rendering, status bar, workspace lifecycle, and secure process spawning.
- [ ] Build the extension bundle and fix build/type issues without changing protocol behavior.

### Task 10: Documentation and full verification

**Files:**
- Modify: `README.md`
- Modify: `.env.example`
- Modify: `技术方案报告.md` only if generated architecture descriptions remain accurate.

- [ ] Document queue shortcuts, history commands, RPC/SDK, eval, Docker prerequisites, and VS Code development installation.
- [ ] Re-read the specification and map every acceptance criterion to a passing test.
- [ ] Run `npm test`.
- [ ] Run `npm run typecheck`.
- [ ] Run `npm run build`.
- [ ] Run `npm run vscode:build`.
- [ ] Run `npm run smoke:install`.
- [ ] Inspect `git diff --check`, `git status --short`, and confirm no commits or staged files were created.
