# Structured Output and Tool JSON Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a reusable Zod-backed structured-output wrapper and use the configured cheap model to repair malformed tool JSON without terminating the task.

**Architecture:** Preserve invalid tool arguments as provider-neutral model events, then let `AgentLoop` repair only those arguments through a tool-calling `withStructuredOutput()` wrapper. The wrapper owns schema validation, error feedback, abort-aware 1/2/4 second retry delays, and usage accounting; the main conversation receives only the validated repaired call. Transcript retry rows gain a bright-yellow semantic tone.

**Tech Stack:** TypeScript 7, Node.js 20+, Zod 4, OpenAI SDK 6, Anthropic SDK 0.111, React/Ink, Vitest 4.

## Global Constraints

- Work directly on `main`.
- Do not create commits; the user will review and commit later.
- The original invalid main-model output triggers repair and is not counted as a repair attempt.
- Make one immediate cheap-model repair call plus at most three retries delayed by 1,000, 2,000, and 4,000 milliseconds.
- Prefer `fallbackModelId`; use the current model only when no cheap model is configured.
- Never persist or audit raw malformed tool arguments.
- Preserve assistant prose and the original tool-call id; replace only the invalid input.
- Use tool calling, not provider-native response formats, for the first structured-output implementation.
- Render retry status rows with `ansi:yellowBright`, distinct from error red and success green.

---

### Task 1: Preserve malformed tool arguments at adapter boundaries

**Files:**
- Modify: `src/models/types.ts`
- Modify: `src/models/anthropic.ts`
- Modify: `src/models/openai.ts`
- Test: `tests/models/adapters.test.ts`

**Interfaces:**
- Produces: `ProviderErrorCode` values `invalid_tool_arguments` and `structured_output_error`.
- Produces: `ModelEvent` variant `{ type: "invalid-tool-call"; id: string; name: string; rawInput: string; error: ProviderError }`.
- Changes the built-in Anthropic client boundary from `messages.stream()` to raw `messages.create({ stream: true })` events.

- [ ] **Step 1: Write failing adapter tests**

Add tests that expect malformed arguments to remain recoverable:

```ts
it("emits recoverable Anthropic tool arguments with invalid escapes", async () => {
  const raw = String.raw`{"path":"C:\Users\wangzh"}`;
  const client = { messages: { create: () => events(
    { type: "message_start", message: { usage: { input_tokens: 5, output_tokens: 0 } } },
    { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "tool_1", name: "Read", input: {} } },
    { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: raw } },
    { type: "content_block_stop", index: 1 },
    { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 4 } },
    { type: "message_stop" },
  ) } };

  const output = await collect(new AnthropicModelAdapter({ client: asAnthropicClient(client) }).stream(request));

  expect(output).toContainEqual(expect.objectContaining({
    type: "invalid-tool-call", id: "tool_1", name: "Read", rawInput: raw,
    error: expect.objectContaining({ code: "invalid_tool_arguments" }),
  }));
});
```

Add the equivalent OpenAI test around `response.function_call_arguments.done` and assert id, name, and raw arguments are preserved.

- [ ] **Step 2: Run the adapter tests and verify RED**

Run: `npm test -- --run tests/models/adapters.test.ts`

Expected: FAIL because `invalid-tool-call` and `messages.create` are not implemented.

- [ ] **Step 3: Add stable event/error types**

Extend `ProviderErrorCode` and `ModelEvent` exactly as described in Interfaces. Ensure `error.code` on invalid calls is `invalid_tool_arguments` and its message includes the parser failure but not any unrelated provider data.

- [ ] **Step 4: Switch Anthropic to raw streaming and emit invalid events**

Change `AnthropicClient.messages` to expose the streaming `create` overload, call it with `{ ...body, stream: true }`, accumulate raw fragments, and at `message_stop` use:

```ts
try {
  const input = normalizeToolCallInput(pending.json || "{}");
  yield { type: "tool-call", id: pending.id, name: pending.name, input };
} catch (error) {
  yield {
    type: "invalid-tool-call",
    id: pending.id,
    name: pending.name,
    rawInput: pending.json,
    error: { code: "invalid_tool_arguments", message: message(error) },
  };
}
```

Keep output-limit handling, usage, incomplete-block detection, and valid tool behavior unchanged.

- [ ] **Step 5: Catch OpenAI argument failures locally**

Centralize completed OpenAI call emission in a helper that catches `normalizeToolCallInput()` and returns either `tool-call` or `invalid-tool-call`, retaining the raw `arguments` string.

- [ ] **Step 6: Run adapter tests GREEN**

Run: `npm test -- --run tests/models/adapters.test.ts`

Expected: PASS.

### Task 2: Add the reusable structured-output wrapper

**Files:**
- Create: `src/models/structured.ts`
- Create: `tests/models/structured.test.ts`
- Modify: `src/harness/local.ts`

**Interfaces:**
- Produces: `withStructuredOutput<T>(options): StructuredModel<T>` using a `z.ZodType<T>` schema.
- Produces: streaming events for usage, retry, validated output, and terminal error.
- Reuses: one strict synthetic `ModelTool` generated from the target Zod schema.

- [ ] **Step 1: Write failing success and validation-feedback tests**

Use a real `ModelRegistry` with fake adapters and assert the wished-for API:

```ts
const model = withStructuredOutput({
  registry,
  modelId: "cheap:model",
  name: "Read",
  description: "Read a file",
  schema: z.object({ path: z.string() }).strict(),
});

const result = await model.invoke({
  messages: [{ role: "user", content: "Repair this tool input" }],
  invalidOutput: String.raw`{"path":"C:\Users"}`,
  validationError: "Bad escaped character at position 12",
});

expect(result.value).toEqual({ path: "C:\\Users" });
```

Add a second test whose first cheap response is schema-invalid and assert the next request contains both the candidate and the Zod issue for `path`.

- [ ] **Step 2: Write failing retry, cancellation, and usage tests**

With fake timers, assert one initial call plus three retries, delays `[1000, 2000, 4000]`, cumulative usage across all calls, cancellation during backoff, and a final `structured_output_error` whose message omits the raw malformed input.

- [ ] **Step 3: Run the structured tests and verify RED**

Run: `npm test -- --run tests/models/structured.test.ts`

Expected: FAIL because the module does not exist.

- [ ] **Step 4: Extract strict schema conversion**

Move `ensureStrictSchema()` and Zod-to-model-tool conversion from `src/harness/local.ts` into exported helpers in `src/models/structured.ts`. Update `LocalHarness` to use the shared helper so ordinary and structured tools follow identical schema rules.

- [ ] **Step 5: Implement `StructuredModel.stream()`**

For each physical call:

```ts
const { adapter, model } = registry.get(modelId);
const request: ModelRequest = {
  model,
  messages: repairMessages(baseMessages, invalidOutput, lastCandidate, lastError),
  tools: [toStructuredModelTool(name, description, schema)],
  ...(signal === undefined ? {} : { signal }),
};
```

Collect exactly one matching tool call, reject text-only/multiple/wrong-tool results, run `schema.safeParse()`, and yield a typed output only on success. An `invalid-tool-call` becomes the next candidate/error. Before each retry, yield retry metadata then await the abort-aware backoff.

- [ ] **Step 6: Implement `invoke()` and safe terminal messages**

Consume the stream, aggregate usage, return `{ value, usage, attempts }`, and throw/return a stable terminal error that contains the tool name and final validation message but never `invalidOutput` or the raw candidate.

- [ ] **Step 7: Run structured tests GREEN**

Run: `npm test -- --run tests/models/structured.test.ts`

Expected: PASS.

### Task 3: Validate and repair tool calls in `AgentLoop`

**Files:**
- Modify: `src/tools/runtime.ts`
- Modify: `src/agent/types.ts`
- Modify: `src/agent/loop.ts`
- Test: `tests/tools/runtime.test.ts`
- Test: `tests/agent/loop.test.ts`

**Interfaces:**
- Produces: side-effect-free `ToolRuntime.definition(name)` and `ToolRuntime.validate(call)` methods.
- Produces: `AgentEvent` variant `structured-output-retry`.
- Consumes: `ModelEvent.invalid-tool-call` and `withStructuredOutput()`.

- [ ] **Step 1: Write failing runtime boundary tests**

Assert `validate()` returns parsed Zod input or a validation error without emitting hooks, checking permissions, or executing the tool. Assert `definition()` returns the name, description, and original Zod schema and returns `undefined` for unknown names.

- [ ] **Step 2: Write a failing loop repair integration test**

Configure the main adapter to emit assistant text, one `invalid-tool-call`, usage, and done. Configure the cheap adapter to emit a valid replacement call. Assert:

```ts
expect(requests.map(({ model }) => model)).toEqual(["model", "small", "model"]);
expect(events.filter((event) => event.type === "text").map((event) => event.text))
  .toEqual(["Checking ", "finished"]);
expect(executions).toEqual([{ path: "C:\\Users\\wangzh" }]);
expect(contextToolCall).toMatchObject({ id: "call-1", name: "Read" });
```

The repaired cheap call id must not replace `call-1`.

- [ ] **Step 3: Write failing schema-invalid, multiple-call, exhaustion, hook, and cancellation tests**

Cover valid JSON rejected by Zod, two invalid calls repaired before either tool executes, terminal exhaustion with zero executions, usage totals, repair hook metadata, and cancellation during 1/2/4 second backoff.

- [ ] **Step 4: Run focused loop/runtime tests and verify RED**

Run: `npm test -- --run tests/tools/runtime.test.ts tests/agent/loop.test.ts`

Expected: FAIL for missing runtime methods and repair behavior.

- [ ] **Step 5: Implement side-effect-free runtime lookup and validation**

Return a discriminated validation result and reuse it inside `execute()` so parsing behavior has one source of truth. Do not emit `PreToolUse`, permission, or failure hooks from `validate()`.

- [ ] **Step 6: Collect invalid calls without treating them as provider failures**

In `AgentLoop`, add an `invalidToolCalls` collection beside `toolCalls`. Handle the new adapter event without setting `terminalError`, and preserve usage/completion processing.

- [ ] **Step 7: Repair all invalid or schema-invalid calls before execution**

After the physical main call completes, validate ordinary tool calls, merge them with adapter-invalid calls, and call `withStructuredOutput()` sequentially for each invalid input. Use `fallbackModelId ?? modelId`; retain the original call id/name; add repair usage to run totals; emit `structured-output-retry` events; and only enter the existing execution loop after every call validates.

- [ ] **Step 8: Emit per-attempt model hooks safely**

For each structured call emit `BeforeModelCall`/`AfterModelCall` with `purpose`, `tool`, `repairAttempt`, and `repairMaxAttempts`. Never include raw input in hook payloads. Preserve hook denial/error behavior and final error semantics.

- [ ] **Step 9: Run loop/runtime tests GREEN**

Run: `npm test -- --run tests/tools/runtime.test.ts tests/agent/loop.test.ts`

Expected: PASS.

### Task 4: Render model and structured retries in bright yellow

**Files:**
- Modify: `src/ui/transcript.ts`
- Modify: `src/ui/app.tsx`
- Test: `tests/ui/transcript.test.ts`
- Test: `tests/ui/app-render.test.tsx`

**Interfaces:**
- Produces: optional status-block `tone: "retry"`.
- Maps: retry tone to `ansi:yellowBright` without `dimColor`.

- [ ] **Step 1: Write failing reducer tests**

Update the existing model retry expectation to include `tone: "retry"`. Add a structured retry reducer test that upserts by tool id and also carries the retry tone.

- [ ] **Step 2: Write a failing ANSI render test**

Render a turn containing `{ kind: "status", state: "info", tone: "retry", text: "↻ Retrying model call · attempt 2/5 in 1s" }` and assert the raw Ink string contains the ANSI bright-yellow foreground code while a normal info line remains dim.

- [ ] **Step 3: Run UI tests and verify RED**

Run: `npm test -- --run tests/ui/transcript.test.ts tests/ui/app-render.test.tsx`

Expected: FAIL because retry tone and color mapping are absent.

- [ ] **Step 4: Implement semantic retry presentation**

Add `tone?: "retry"` to status blocks. Set it on both retry reducer branches. In `StatusLine`, choose `ansi:yellowBright` before state-based colors and render retry text without `dimColor`; preserve the existing running/completed/failed mappings.

- [ ] **Step 5: Run UI tests GREEN**

Run: `npm test -- --run tests/ui/transcript.test.ts tests/ui/app-render.test.tsx`

Expected: PASS.

### Task 5: Audit and production integration

**Files:**
- Modify: `src/production.ts`
- Modify: `src/utils/log.ts` only if new typed audit fields are required
- Test: `tests/cli/production.test.ts`

**Interfaces:**
- Consumes: structured repair hook metadata.
- Produces: audit entries for physical repair failures without raw payloads.

- [ ] **Step 1: Write a failing production audit test**

Use a plugin fake adapter that fails one repair attempt then succeeds. Assert audit entries contain model id, purpose, tool, repair attempt/max attempts, and safe validation error; assert the serialized audit and session files do not contain the malformed raw JSON.

- [ ] **Step 2: Run the production test and verify RED**

Run: `npm test -- --run tests/cli/production.test.ts`

Expected: FAIL for missing structured repair metadata.

- [ ] **Step 3: Extend safe audit projection**

Copy only allow-listed structured repair metadata from `AfterModelCall`. Do not spread the hook payload and do not add `rawInput` to `AuditEntry`.

- [ ] **Step 4: Run production tests GREEN**

Run: `npm test -- --run tests/cli/production.test.ts`

Expected: PASS.

### Task 6: Complete verification and handoff

**Files:**
- Review all modified source, test, design, and plan files.

- [ ] **Step 1: Run focused regression suites**

Run: `npm test -- --run tests/models/adapters.test.ts tests/models/structured.test.ts tests/tools/runtime.test.ts tests/agent/loop.test.ts tests/ui/transcript.test.ts tests/ui/app-render.test.tsx tests/cli/production.test.ts`

Expected: PASS.

- [ ] **Step 2: Run full verification**

Run: `npm test`

Run: `npm run typecheck`

Run: `npm run build`

Expected: all commands exit 0. If a pre-existing baseline failure remains, reproduce it against the untouched baseline before classifying it as unrelated.

- [ ] **Step 3: Review repository state without committing**

Run: `git diff --check`

Run: `git status --short`

Run: `git diff --stat`

Confirm there are no generated artifacts, raw malformed payload fixtures containing secrets, or unrelated edits. Do not stage or commit.

