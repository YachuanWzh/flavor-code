# Harness P0-1 and P1-2 Design

## Scope

Implement the two gaps identified by `harness.md`: resilient, confidentiality-preserving configuration persistence (P0-1), and the documented six-mode permission model (P1-2). Existing `safe`, `workspace`, and `full` persisted values remain readable through a one-way compatibility migration.

## Configuration protection

All application-owned JSON writes use a shared protected-file primitive. It acquires a sibling lock file with exclusive creation, retries bounded contention, removes only demonstrably stale locks, re-reads state after acquiring the lock, writes a valid prior state to `<file>.bak`, and replaces the target through a private temporary file that is flushed before rename. Reads validate the primary file and fall back to a valid backup without silently accepting malformed data.

Global `~/.flavor-code/flavor.json` secret-valued fields are stored as versioned AES-256-GCM envelopes. The key is generated once in `~/.flavor-code/.config.key` with private file permissions. AES-GCM authenticates encrypted values, so corrupt or modified ciphertext is rejected. Plaintext legacy global configuration remains readable and is migrated under the same protected-write transaction. Project configuration is not wholesale encrypted because it is user-edited and commonly committed, but MCP toggle updates preserve all unrelated secret fields and cannot race each other.

OAuth `auth.json` is application-owned and therefore always written as an authenticated encrypted envelope. Legacy plaintext token files are readable and migrate on the next save. Lock-time merging preserves providers written by another process; corrupt primary data may recover from the authenticated backup, while invalid primary and backup data fail closed instead of becoming an empty token set.

## Permission modes

The canonical modes are `default`, `acceptEdits`, `plan`, `bypassPermissions`, `auto`, and `bubble`.

- `default`: reads and control tools are allowed; mutations, network access, destructive actions, and shell execution require approval.
- `acceptEdits`: adds automatic workspace-local writes and routine workspace-local verification commands.
- `plan`: permits only read/control behavior; mutating, shell, and network requests are denied.
- `bypassPermissions`: skips ordinary approval for the main Agent, while path-escape and explicitly forbidden-command checks remain hard denials.
- `auto`: includes the `acceptEdits` fast path, then asks a cheap structured-output classifier to decide remaining calls. Classifier failure or uncertainty falls back to human approval.
- `bubble`: is the child-Agent mode. Safe reads/routine verification stay local; requests needing approval are relayed to the main session approval callback.

Legacy persisted values migrate as `safe -> default`, `workspace -> default`, and `full -> bypassPermissions`. This is security-preserving: migration never grants more authority than the closest canonical mode except the explicitly privileged legacy `full` mapping.

## Data flow and failure handling

`FlavorConfigSchema` normalizes permission values before production constructs `LocalHarness`. Main runtimes receive the selected canonical mode and optional auto classifier. Child runtimes always receive `bubble`, except that a main session in `plan` creates plan-limited children. `ToolRuntime` combines hook, deterministic permission, optional classifier, and approval decisions in that order; hard deterministic denials are never sent to the classifier.

Configuration lock acquisition is bounded. A live contending writer results in a descriptive error rather than an unsafe unlocked write. Temporary files and owned locks are cleaned in `finally`. Backup creation never copies plaintext global secrets or OAuth tokens.

## Testing

Tests cover concurrent MCP updates, backup recovery, encrypted global-secret migration, ciphertext tamper rejection, encrypted OAuth persistence and merge behavior, legacy permission migration, every canonical mode's decision matrix, auto allow/deny/fallback behavior, bubble approval routing, slash-command parsing, and session compatibility. Targeted suites run before the full test, typecheck, and build.
