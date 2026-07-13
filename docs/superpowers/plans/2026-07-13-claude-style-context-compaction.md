# Claude-Style Context Compaction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Flavor Code long-running task continuity through token-aware microcompaction, model-generated structured summaries, overflow recovery, circuit breaking, and resumable compact boundaries.

**Architecture:** Extract deterministic compaction policy, grouping, prompt, and microcompaction helpers under `src/context/`, keep transactional conversation ownership in `ContextManager`, and inject a no-tools model summarizer from the production composition root. `AgentLoop` records real input usage and performs one reactive compact/retry on provider overflow; the session store persists a versioned compact boundary.

**Tech Stack:** TypeScript 7, Node.js 20+, Zod 4, Vitest 4, existing provider-neutral `ModelAdapter` and JSONL session store.

## Global Constraints

- Work directly on the current `main` branch; do not create a worktree.
- Do not implement cache editing, background Session Memory, attachment restoration, partial compact UI, `/loop`, or loop scheduling.
- Default context window is 200000 tokens with 20000 reserved output tokens, 13000 auto-compact buffer tokens, 20000 warning buffer tokens, and 3000 blocking buffer tokens.
- Preserve at least 10000 recent tokens or 5 recent text messages, capped at 40000 recent tokens, without splitting tool call/result pairs.
- Keep the most recent 5 compactable tool results during microcompaction.
- Retry prompt-too-long summarization at most 3 times and trip automatic compaction after 3 consecutive failures.
- Every behavior change follows a witnessed red-green TDD cycle.

---

### Task 1: Deterministic compaction policy and prompt helpers

**Files:**
- Create: `src/context/compaction.ts`
- Create: `tests/context/compaction.test.ts`

**Interfaces:**
- Produces: `DEFAULT_COMPACTION_POLICY`, `CompactionPolicy`, `calculateContextPressure()`, `groupMessagesByApiRound()`, `selectRecentStart()`, `microcompactMessages()`, `buildCompactPrompt()`, `formatCompactSummary()`, and `compactContinuationMessage()`.
- Consumes: `ModelMessage` from `src/models/types.ts` and `estimateTokens()` semantics of four characters per token.

- [ ] **Step 1: Write failing tests for thresholds, safe grouping, recent retention, microcompaction, and summary formatting**

```ts
expect(calculateContextPressure(167_000, DEFAULT_COMPACTION_POLICY).shouldAutoCompact).toBe(true);
expect(groupMessagesByApiRound(toolConversation)).toEqual(expectedCompleteRounds);
expect(microcompactMessages(messages, 1).messages[oldToolIndex]?.content).toBe(OLD_TOOL_RESULT_CLEARED);
expect(formatCompactSummary("<analysis>draft</analysis><summary>kept</summary>")).toBe("kept");
expect(buildCompactPrompt()).toContain("Optional Next Step");
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npx vitest run tests/context/compaction.test.ts`

Expected: FAIL because `src/context/compaction.ts` does not exist.

- [ ] **Step 3: Implement the deterministic helpers**

```ts
export interface CompactionPolicy {
  windowTokens: number;
  reservedOutputTokens: number;
  autoCompactBufferTokens: number;
  warningBufferTokens: number;
  blockingBufferTokens: number;
  microcompactKeepRecentToolResults: number;
  recentTokens: number;
  recentTextMessages: number;
  maxRecentTokens: number;
}

export const DEFAULT_COMPACTION_POLICY: CompactionPolicy = {
  windowTokens: 200_000,
  reservedOutputTokens: 20_000,
  autoCompactBufferTokens: 13_000,
  warningBufferTokens: 20_000,
  blockingBufferTokens: 3_000,
  microcompactKeepRecentToolResults: 5,
  recentTokens: 10_000,
  recentTextMessages: 5,
  maxRecentTokens: 40_000,
};
```

Use tool-call IDs to associate tool results with compactable tool names, replace only completed old results, and always return cloned messages. Choose recent boundaries by walking backward over complete API rounds until both minimums are satisfied or the maximum is reached.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `npx vitest run tests/context/compaction.test.ts`

Expected: PASS with no warnings.

### Task 2: Transactional layered ContextManager

**Files:**
- Modify: `src/context/manager.ts`
- Modify: `tests/context/manager.test.ts`

**Interfaces:**
- Consumes: Task 1 compaction helpers.
- Produces: `CompactBoundary`, `ContextSnapshot`, `recordModelUsage(inputTokens)`, `prepareForModelCall(signal)`, and `compact(signal, reason)` where reason is `manual | reactive`.

- [ ] **Step 1: Add failing tests for usage-aware auto compact, manual forcing, microcompact-first behavior, continuation messages, and three-failure circuit breaking**

```ts
context.recordModelUsage(167_000);
await expect(context.prepareForModelCall()).resolves.toBe(true);
expect(context.messagesForModel()[3]?.role).toBe("user");
expect(context.messagesForModel()[3]?.content).toContain("continued from a previous conversation");
```

Also verify that a failed summary or failed `PostCompact` leaves the prior boundary and messages byte-for-byte unchanged, and that manual compaction still runs after the automatic circuit breaker trips.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npx vitest run tests/context/manager.test.ts`

Expected: FAIL on missing layered-compaction APIs and changed summary semantics.

- [ ] **Step 3: Refactor ContextManager around a compact boundary**

```ts
export interface CompactBoundary {
  summary: string;
  compactedAt: string;
}

export interface ContextSnapshot {
  compact?: CompactBoundary;
  messages: ModelMessage[];
}
```

`prepareForModelCall()` uses recorded input usage when present, otherwise estimated visible tokens. It performs microcompaction first, attempts full auto compaction only when pressure remains, catches auto failures, increments the per-context failure count, and returns whether any mutation occurred. `compact(..., "manual" | "reactive")` bypasses the circuit breaker and forces a full transactional compact whenever an older complete round exists.

- [ ] **Step 4: Run ContextManager tests and verify GREEN**

Run: `npx vitest run tests/context/manager.test.ts`

Expected: PASS.

### Task 3: Provider-backed summary generation with PTL recovery

**Files:**
- Create: `src/context/summarizer.ts`
- Create: `tests/context/summarizer.test.ts`
- Modify: `src/harness/local.ts`
- Modify: `tests/agent/subagents.test.ts`

**Interfaces:**
- Produces: `summarizeWithModel(options)` accepting `registry`, `modelId()`, messages, prompt, signal, and `maxPromptTooLongRetries`.
- Changes harness factory to `createContext(agent: "main" | "subagent"): ContextManager` so each context receives the correct current model accessor.

- [ ] **Step 1: Write failing summarizer tests**

```ts
expect(requests[0]?.tools).toEqual([]);
expect(requests[0]?.messages.at(-1)?.content).toContain("TEXT ONLY");
expect(summary).toBe("structured result");
```

Add a fake adapter that returns `context_overflow` twice and succeeds after the oldest complete round has been removed. Add terminal cases for empty text, non-overflow error, abort, and exceeding three PTL retries.

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `npx vitest run tests/context/summarizer.test.ts tests/agent/subagents.test.ts`

Expected: FAIL because the summarizer and role-aware context factory do not exist.

- [ ] **Step 3: Implement the one-turn, no-tools summarizer and role-aware context construction**

```ts
const request: ModelRequest = {
  model: resolved.model,
  messages: [...candidate, { role: "user", content: buildCompactPrompt() }],
  tools: [],
  signal,
};
```

Collect text until `done`, normalize provider errors, retry only `context_overflow`, and drop one oldest API-round group per retry. Never retry cancellation, authentication, rate limit, network, or unknown errors.

- [ ] **Step 4: Run the focused tests and verify GREEN**

Run: `npx vitest run tests/context/summarizer.test.ts tests/agent/subagents.test.ts`

Expected: PASS.

### Task 4: AgentLoop proactive and reactive integration

**Files:**
- Modify: `src/agent/loop.ts`
- Modify: `tests/agent/loop.test.ts`
- Modify: `src/agent/types.ts`

**Interfaces:**
- Consumes: `ContextManager.prepareForModelCall()`, `ContextManager.compact(..., "reactive")`, and `recordModelUsage()`.
- Produces: one `compacted` event per actual context change and at most one reactive retry per model iteration.

- [ ] **Step 1: Add failing loop tests**

```ts
expect(adapter.requests).toHaveLength(2);
expect(events.filter(event => event.type === "compacted")).toHaveLength(1);
expect(context.lastRecordedInputTokens).toBe(usage.inputTokens);
```

The first adapter request returns `context_overflow`; the second succeeds. Verify the original user prompt appears once, no tool result is duplicated, and a second overflow exits with the provider error rather than looping.

- [ ] **Step 2: Run the loop test and verify RED**

Run: `npx vitest run tests/agent/loop.test.ts`

Expected: FAIL because the loop currently returns immediately on overflow.

- [ ] **Step 3: Implement proactive preparation, usage recording, and one-shot reactive retry**

Perform proactive preparation at the start of an iteration. Wrap the model request in an inner retry loop with a `reactiveRetried` flag. On completed usage, call `recordModelUsage(usage.inputTokens)`. On first context overflow, force reactive compact, emit `compacted`, rebuild messages, and retry without advancing the iteration.

- [ ] **Step 4: Run the loop test and verify GREEN**

Run: `npx vitest run tests/agent/loop.test.ts`

Expected: PASS.

### Task 5: Configuration and production composition

**Files:**
- Modify: `src/config/schema.ts`
- Modify: `tests/config/load.test.ts`
- Modify: `src/production.ts`
- Modify: `tests/cli/production.test.ts`
- Modify: `src/ui/session.ts`

**Interfaces:**
- Produces the documented context configuration fields and maps deprecated `compactAtChars` to an explicit token threshold only when supplied.
- Injects `summarizeWithModel()` using the main or subagent current model accessor.
- Makes `/compact` call the manual force path and persist only after a successful mutation.

- [ ] **Step 1: Add failing config and production tests**

```ts
expect(FlavorConfigSchema.parse({}).context.windowTokens).toBe(200_000);
expect(FlavorConfigSchema.parse({ context: { compactAtChars: 4_000 } }).context.compactAtChars).toBe(4_000);
```

Use a fake production adapter to prove manual compact issues a second no-tools model request containing the structured prompt and persists the returned compact boundary.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `npx vitest run tests/config/load.test.ts tests/cli/production.test.ts`

Expected: FAIL on missing fields and the current string-slicing summarizer.

- [ ] **Step 3: Wire configuration and real summarization into production**

Extend the Zod schema with positive bounded integers for all policy values. Map old `compactAtChars / 4` to the automatic token threshold for compatibility. Remove the concatenation-and-`slice(-40_000)` implementation.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `npx vitest run tests/config/load.test.ts tests/cli/production.test.ts`

Expected: PASS.

### Task 6: Versioned compact-boundary persistence

**Files:**
- Modify: `src/session/store.ts`
- Modify: `tests/session/store.test.ts`
- Modify: `src/production.ts`

**Interfaces:**
- New writes use session version 2 and `conversation.compact`.
- Reads accept version 1 `conversation.summary`/metadata `summary` and convert a valid `Conversation summary\n...` value into `CompactBoundary`.

- [ ] **Step 1: Add failing persistence tests**

```ts
expect(meta.version).toBe(2);
expect(meta.compact.summary).toBe("structured summary");
expect(loaded.conversation.compact).toMatchObject({ summary: "structured summary" });
```

Keep the existing legacy single-line JSON and v1 JSONL fixtures and assert they still load. Verify malformed or oversized compact boundaries are quarantined like other invalid sessions.

- [ ] **Step 2: Run session tests and verify RED**

Run: `npx vitest run tests/session/store.test.ts`

Expected: FAIL because the store only supports strict version 1 summaries.

- [ ] **Step 3: Implement the v2 write schema and explicit v1 migration**

Parse raw metadata with a version discriminant, validate v1 and v2 separately, migrate v1 in memory, then return the v2 `SessionDocument`. Continue sanitizing and size-limiting all strings. Update production snapshot/restore conversion to use `compact`.

- [ ] **Step 4: Run session tests and verify GREEN**

Run: `npx vitest run tests/session/store.test.ts`

Expected: PASS.

### Task 7: User and technical documentation

**Files:**
- Modify: `README.md`
- Modify: `技术方案报告.md`

**Interfaces:**
- Documents the actual defaults, `/compact`, proactive and reactive behavior, persistence, failure circuit breaker, and explicit non-goals.

- [ ] **Step 1: Update README usage and configuration sections**

Explain that Flavor first clears old tool results, then generates a nine-section model summary near the token threshold, and resumes directly after overflow recovery. Add a complete `context` JSON example with all supported fields and mark `compactAtChars` deprecated.

- [ ] **Step 2: Update the technical report architecture and flow**

Replace the character-threshold MVP description with the layered data flow, model-backed summarizer, API-safe grouping, PTL retry, reactive retry, circuit breaker, and v2 session boundary. State that cache editing, Session Memory, attachments, partial compact, and `/loop` remain future layers.

- [ ] **Step 3: Check documentation consistency**

Run: `rg -n "compactAtChars|240000|字符数/4|Conversation summary|SESSION_VERSION|上下文压缩|/compact" README.md 技术方案报告.md`

Expected: every legacy statement is either removed or explicitly labelled compatibility behavior.

### Task 8: Full verification and review

**Files:**
- Review all files changed by Tasks 1-7.

**Interfaces:**
- Confirms the implementation meets the approved spec without unrelated behavior changes.

- [ ] **Step 1: Run the complete test suite**

Run: `npm test`

Expected: all tests pass with zero failures.

- [ ] **Step 2: Run static and build verification**

Run: `npm run typecheck`

Expected: exit code 0 with no TypeScript diagnostics.

Run: `npm run build`

Expected: exit code 0 and production bundles emitted to `dist/`.

- [ ] **Step 3: Inspect the diff and requirement coverage**

Run: `git diff --check && git status --short && git diff --stat HEAD~1`

Expected: no whitespace errors, only in-scope files, and every approved design requirement mapped to implementation or an explicit non-goal.

- [ ] **Step 4: Request focused code review and address Critical/Important findings**

Review against `docs/superpowers/specs/2026-07-13-claude-style-context-compaction-design.md`, with special attention to retry loops, context mutation transactionality, tool-pair validity, session migration, and secret handling.
