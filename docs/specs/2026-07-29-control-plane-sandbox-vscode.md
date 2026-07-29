# Flavor Control Plane, Sandbox, and VS Code Integration

## Status

Implementation specification for the post-1.0.2 control-plane release.

## Goals

1. Let callers steer an active agent run and queue follow-up work without cancelling it.
2. Persist an append-only session tree and restore both conversation state and workspace files.
3. Expose the production runtime through a supported TypeScript SDK and a strict JSONL RPC protocol.
4. Record deterministic traces, replay them without a model, and execute repeatable coding-agent evaluations.
5. Execute shell commands through an explicit execution environment, including a Docker sandbox.
6. Connect VS Code to Flavor through the same RPC protocol used by other non-Node clients.

## Non-goals

- Cloud session synchronization.
- A hosted multi-user control plane.
- Containerizing the Electron renderer or MCP servers.
- Snapshotting `.git`, `.flavor`, ignored build output, dependency folders, or files above the checkpoint size budget.
- Replaying model inference; replay emits recorded events and never calls a provider.
- A custom VS Code chat participant. The first integration uses commands, the active editor, diagnostics, and an output channel.

## Compatibility

- Existing session v1-v3 documents continue to load.
- Existing `FlavorSession.submit()` remains serial and keeps its return-on-completion behavior.
- `submit()` during an active run remains valid for existing callers and queues a normal follow-up.
- New explicit `steer()` and `followUp()` methods expose delivery intent.
- Local execution remains the default. Docker is opt-in through configuration or SDK options.
- CLI interactive and `--print` behavior remains unchanged unless `--mode rpc`, `--trace`, or `eval` is selected.

## 1. Message queue

### API

```ts
type QueueKind = "steer" | "followUp";
type QueueMode = "one-at-a-time" | "all";

interface QueueSnapshot {
  steering: readonly string[];
  followUp: readonly string[];
}
```

`FlavorSession.steer(text)` queues text for the active agent loop. The loop drains steering messages after a complete tool batch and before the next model call. If there is no active run, steering starts a normal submission.

`FlavorSession.followUp(text)` queues work that starts only after the active run, including all steering continuations, has completed.

`FlavorSession.clearQueue()` returns and removes all pending messages. Interrupting restores pending messages; closing rejects new input and drains no new work.

The desktop composer remains enabled while busy. Enter sends steering and Alt+Enter sends a follow-up. Queue state is included in desktop snapshots.

## 2. Session tree and checkpoints

### Session tree

Each completed user turn creates one append-only node:

```ts
interface SessionTreeNode {
  id: string;
  parentId: string | null;
  createdAt: string;
  prompt: string;
  checkpointId: string;
  context: ContextSnapshot;
}
```

The active leaf is a movable pointer. Rewinding never deletes nodes. Continuing after a rewind creates a branch.

Tree metadata is stored under `.flavor/session-trees/<session-id>/tree.json`. Node contexts are bounded by the existing session size limit and written atomically.

### Workspace checkpoints

Checkpoints include regular files returned by `git ls-files --cached --others --exclude-standard`. For non-Git projects, Flavor walks the workspace with the same hard exclusions. `.git`, `.flavor`, `node_modules`, `dist`, `build`, `release`, and `.worktrees` are excluded.

The manifest records each path, mode, size, and SHA-256. File contents are stored by digest under `.flavor/checkpoints/objects/`, so adjacent checkpoints deduplicate unchanged files.

Restore:

1. Validate every manifest path remains within the workspace.
2. Save a transient pre-revert checkpoint.
3. Restore manifest files atomically.
4. Remove only files that are in the current tracked set but absent from the target.
5. Restore the node context and move the active leaf.

`unrevert` restores the transient checkpoint and previous context/leaf. Only one unrevert slot is retained.

Commands:

- `/checkpoint [label]`
- `/tree`
- `/rewind <node-id>`
- `/unrevert`
- `/fork <node-id>` (moves context/leaf without changing files)

## 3. SDK and RPC

### SDK

The package exports `flavor-code/sdk` with:

- `createFlavorRuntime`
- `createProductionRuntime`
- `FlavorSession`
- public runtime, event, queue, tree, checkpoint, and execution-environment types

The SDK does not depend on Electron or Ink.

### RPC

`flavor --mode rpc [--workspace <path>] [--resume [session-id]] [--trace <path>]`

Input and output are UTF-8 JSON objects delimited by LF. Invalid input produces an error response and does not terminate the server.

Commands:

- `prompt`, `steer`, `follow_up`, `abort`
- `get_state`, `get_queue`, `clear_queue`
- `checkpoint`, `get_tree`, `rewind`, `unrevert`, `fork`
- `shutdown`

Every request may contain an `id`. Immediate acceptance is returned as a response; runtime output is emitted as `event` records containing the session id.

Only one prompt is active, but steer/follow-up commands are accepted concurrently.

## 4. Trace, replay, and eval

Trace JSONL records have a version, sequence number, timestamp, session id, and one of:

- RPC command/response
- session output event
- queue update
- checkpoint/tree operation
- evaluation verification result

Secrets pass through the existing redaction layer before serialization.

`TraceReplay` validates sequence monotonicity and yields recorded output events without constructing a model adapter.

An eval spec contains:

```json
{
  "name": "fix-parser",
  "workspace": "./fixture",
  "prompt": "Fix the parser",
  "verification": [
    { "command": "npm", "args": ["test"], "timeoutMs": 120000 }
  ],
  "maxTokens": 200000
}
```

The runner accepts injected `createRuntime` and `ExecutionEnv` dependencies, records duration/token counts/verification results, and writes a machine-readable report. CLI: `flavor eval <spec.json> [--output <report.json>]`.

## 5. Execution environments

```ts
interface ExecutionEnvironment {
  readonly kind: "local" | "docker";
  exec(input: ExecutionRequest, signal?: AbortSignal): Promise<ExecutionResult>;
  dispose(): Promise<void>;
}
```

The Shell tool delegates execution to this interface.

### Local

Matches existing behavior, including output bounds, timeout, process-tree termination, and workspace cwd validation.

### Docker

The Docker backend launches:

```text
docker run --rm --init
  --network none
  --read-only
  --cap-drop ALL
  --security-opt no-new-privileges
  --pids-limit 256
  --memory 2g
  --cpus 2
  --tmpfs /tmp:rw,nosuid,nodev,size=256m
  --mount type=bind,source=<workspace>,target=/workspace
  --workdir /workspace/<relative-cwd>
  <image> <command> <args...>
```

Configuration:

```json
{
  "execution": {
    "mode": "docker",
    "image": "node:24-bookworm-slim",
    "network": false,
    "memory": "2g",
    "cpus": 2
  }
}
```

Enabling network removes `--network none`; it does not use host networking. Docker availability is checked at runtime. Sandbox failure is fail-closed and never falls back to local execution.

## 6. VS Code

The extension lives in `extensions/vscode`.

Commands:

- `Flavor: Start Session`
- `Flavor: Ask About Selection`
- `Flavor: Fix Current Diagnostics`
- `Flavor: Steer Active Task`
- `Flavor: Queue Follow-up`
- `Flavor: Stop Active Task`
- `Flavor: Show Session Tree`
- `Flavor: Rewind Session`

It starts `flavor --mode rpc --workspace <root>`, sends the selected text and visible diagnostics as bounded prompt context, renders streamed text/tool status in an output channel, and exposes status-bar state.

The RPC client is transport-isolated and testable with in-memory streams. Extension activation owns one client per workspace folder and terminates it on deactivation.

## Security invariants

- RPC never evaluates input and accepts only schema-validated commands.
- Trace output is redacted and created with restrictive file permissions where supported.
- Checkpoint paths are relative, normalized, non-symlink files within the workspace.
- Restore never touches excluded directories or paths absent from its managed current-file set.
- Docker mode never silently degrades to local execution.
- VS Code passes prompts as JSON records, never through shell string interpolation.

## Acceptance criteria

1. A running tool loop consumes steering before its next model call.
2. Follow-up work starts after the current run and queued steering finish.
3. Desktop and RPC display queue state and accept input while busy.
4. Rewind restores conversation, files, and leaf; unrevert restores the pre-rewind state.
5. Continuing after rewind creates a second child branch without deleting the first.
6. SDK can run an injected fake provider without CLI or Electron imports.
7. RPC survives malformed records and supports concurrent steer while prompt is active.
8. Trace replay emits the recorded event order without a provider.
9. Eval produces verification and token-budget results.
10. Docker command construction enforces the documented defaults and fail-closed behavior.
11. VS Code extension builds and its RPC client/command prompt builders pass tests.
12. Existing test suite, typecheck, builds, and install smoke test pass.

