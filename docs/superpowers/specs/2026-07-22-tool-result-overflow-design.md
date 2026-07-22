# Tool result size limits and overflow persistence

## Goal

Limit tool-result content before it enters hooks, agent events, or conversation context, while preserving the complete result on disk so the model can retrieve it with `Read` when needed.

This is an execution-layer guard. The existing context-layer `toolOutputChars` truncation remains as defense in depth for restored sessions and externally supplied messages.

## Behavior

- `ToolRuntime` defaults to an inline content budget of 50,000 characters per tool result and 200,000 characters for all tool results in one model turn.
- `AgentLoop` starts a fresh runtime budget immediately before executing the tool calls returned by one model response.
- Results within both budgets are returned unchanged.
- A result exceeding either budget is serialized and stored below `<workspace>/.flavor/tool-results/`.
- The inline result becomes a structured overflow reference containing:
  - a head/tail preview constrained by the remaining content budget;
  - the original character count;
  - the number of preview characters returned;
  - the limit that caused truncation; and
  - an absolute `savedTo` path suitable for a follow-up `Read` call.
- Reference metadata is exempt from the content budget. This guarantees that a recoverable path is still returned after the 200,000-character turn budget is exhausted.
- The post-tool hook observes the bounded result, not the unbounded original. Presentation metadata is extracted before bounding and remains available to the UI.
- A new turn resets only the aggregate counter; persisted overflow files remain available for the session and later turns.

Character accounting uses the text returned directly by string-valued tools and compact JSON for other serializable values. Persisted files use the same representation, so their contents match what was measured.

## Configuration and validation

`ToolRuntimeOptions` accepts an optional `outputLimits` object with `perToolChars` and `perTurnChars`. Both values must be positive integers. Production uses the defaults; tests and embedders can lower them deterministically.

`workspace` controls the persistence root and defaults to the current working directory for backwards compatibility with direct runtime construction.

## Failure semantics

Overflow persistence is part of successful result handling. If persistence fails, execution returns the existing `tool_error` failure rather than forwarding an unbounded result. Values that cannot be serialized retain the pre-existing downstream serialization-error behavior in `AgentLoop`; the limiter does not convert them into a different failure type.

## Acceptance tests

1. An under-limit result retains its original value and does not create an overflow file.
2. A per-tool overflow returns a bounded head/tail preview and a readable file containing the complete result.
3. Multiple calls share the per-turn budget; the call crossing it is persisted with only the remaining preview allowance.
4. Starting a new turn restores the aggregate budget.
5. The post-tool hook receives the overflow reference.
6. Invalid limit configuration is rejected at construction time.
