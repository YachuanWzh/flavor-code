# Structured Output and Tool JSON Repair Design

## Context

Flavor Code currently validates tool inputs with Zod and converts those schemas to strict JSON Schema before sending tools to providers. It also has special-purpose structured boundaries such as `TaskOutput` and `SubagentResultSchema`. It does not have a model-level equivalent of LangChain's `withStructuredOutput()`: `ModelRequest` cannot declare an output schema, adapters do not return a validated structured result, and schema failures do not carry repair feedback into a follow-up model call.

The immediate production failure is malformed tool-call JSON from an Anthropic-compatible DeepSeek endpoint. The Anthropic SDK's high-level `messages.stream()` parses accumulated `input_json_delta` data before Flavor Code can inspect it, so an invalid escape such as `C:\Users` terminates the model call as an unknown provider error. Generic retries resend the same conversation without explaining the validation failure.

## Goals

- Add a reusable `withStructuredOutput()` model wrapper backed by Zod.
- Use tool calling as the provider-neutral structured-output strategy.
- Preserve malformed tool-call payloads long enough to diagnose and repair them.
- Repair only the invalid tool arguments; do not regenerate assistant prose or restart the task.
- Prefer the configured cheap/subagent model for repair.
- Give every repair attempt the raw candidate, target schema, and previous validation error.
- Make one initial repair call and allow three retries with 1, 2, and 4 second delays.
- Validate both JSON syntax and the target Zod schema before executing a repaired tool call.
- Account for repair token usage and audit every physical model attempt.
- Stop only after repair is exhausted, cancelled, or cannot be attempted safely.

## Non-goals

- Adding LangChain or LangGraph as dependencies.
- Silently mutating invalid escape sequences with regex-based JSON repair.
- Implementing provider-native response formats in this change. Tool calling is the common strategy supported by the current adapters and the configured DeepSeek-compatible endpoint.
- Retrying authentication, permission, cancellation, or unknown-tool failures as structured-output failures.
- Persisting raw malformed payloads in audit logs or session files.

## Public structured-output API

Create `src/models/structured.ts` with a Zod-backed wrapper:

```ts
export interface StructuredOutputRetryPolicy {
  maxRetries: number;
  backoffMs: readonly number[];
}

export interface StructuredOutputOptions<T> {
  registry: ModelRegistry;
  modelId: string;
  name: string;
  description: string;
  schema: z.ZodType<T>;
  retry?: StructuredOutputRetryPolicy;
}

export interface StructuredOutputRequest {
  messages: ModelMessage[];
  invalidOutput?: string;
  validationError?: string;
  signal?: AbortSignal;
}

export function withStructuredOutput<T>(
  options: StructuredOutputOptions<T>,
): StructuredModel<T>;
```

`StructuredModel<T>` exposes a streaming method so callers can observe usage, retry, and completion events without duplicating adapter logic. It also exposes `invoke()` as a convenience that consumes the stream and returns the validated value plus cumulative usage.

The wrapper converts the Zod schema with `z.toJSONSchema()`, applies the same strict-object normalization used by ordinary tools, and offers exactly one synthetic output tool to the selected model. A result is successful only when the adapter produces that tool call and `schema.parse()` succeeds.

## Model event boundary

Extend the provider-neutral event union with an invalid tool-call event:

```ts
{
  type: "invalid-tool-call";
  id: string;
  name: string;
  rawInput: string;
  error: { code: "invalid_tool_arguments"; message: string };
}
```

Add `invalid_tool_arguments` and `structured_output_error` to the stable provider/agent error codes. Adapters must distinguish malformed model output from transport failures instead of normalizing all parsing exceptions to `unknown`.

Raw malformed input is an in-memory recovery value. Hooks and audit entries may include the tool name, character count, and validation message, but must not include `rawInput`.

## Adapter changes

### Anthropic

Use `messages.create({ ...body, stream: true })` and iterate the raw SSE events instead of using the SDK's high-level `messages.stream()` accumulator. Flavor Code remains responsible for accumulating `input_json_delta.partial_json` fragments.

At `message_stop`, normalize each accumulated tool input. Successful inputs emit ordinary `tool-call` events. Parsing failures emit `invalid-tool-call` with the original tool id, name, raw input, and precise parser error. Usage is still emitted once, and the stream completes normally so the agent can repair the invalid calls.

An invalid outer SSE envelope still remains a provider error because no trustworthy tool id, name, or raw inner payload can be recovered.

### OpenAI

Keep the Responses stream, but catch `normalizeToolCallInput()` failures around completed function arguments and emit the same `invalid-tool-call` event. Preserve the call id, function name, and raw `arguments` string.

## Agent-loop repair flow

The main loop collects valid and invalid tool calls for the turn. It does not execute any tool until all calls in that assistant turn have valid inputs.

For each invalid call:

1. Resolve the original Zod input schema from `ToolRuntime` without executing hooks or requesting permissions.
2. Choose `fallbackModelId` (the configured cheap model) as the repair model. If no cheap model exists, use the current model so malformed output remains recoverable in minimal configurations.
3. Build a structured-output wrapper using the original tool name, description, and Zod schema.
4. Send a repair request containing the malformed raw JSON, parser or Zod error, and strict instructions to return only the corrected tool arguments through the structured-output tool.
5. Validate the generated arguments with the original Zod schema.
6. On success, retain the original main-model tool-call id and replace only its input.
7. On failure, add the latest candidate and validation error to the next repair prompt.

Valid JSON that fails the Zod tool schema follows the same path. This validation happens before tool execution, so schema mistakes do not become ordinary failed tool results.

Multiple invalid calls are repaired independently and sequentially. This keeps prompts small and preserves the existing atomic assistant turn: no tool from the turn executes until every call is valid.

Assistant text already streamed before the invalid tool call is preserved and is not generated again.

## Retry semantics

The original main-model failure triggers repair and is not counted as a repair attempt.

- Repair attempt 1 runs immediately on the cheap model.
- Retry 1 waits 1,000 ms.
- Retry 2 waits 2,000 ms.
- Retry 3 waits 4,000 ms.
- Maximum cheap-model calls per invalid tool call: 4.

Every retry prompt contains:

- tool name and description;
- strict JSON Schema;
- original malformed input;
- the most recent generated candidate, when available;
- the exact JSON or Zod validation error;
- an instruction not to change the tool's intent or invent fields.

Backoff uses the existing abort-aware waiting behavior. Cancellation stops immediately and returns `cancelled`. Exhaustion returns `structured_output_error` containing the tool name, number of attempts, and final validation message, but not the raw payload.

## Usage, hooks, and UI events

Each structured repair model call emits the existing `BeforeModelCall` and `AfterModelCall` hooks with additional metadata:

```ts
{
  purpose: "structured-output-repair";
  tool: string;
  repairAttempt: number;
  repairMaxAttempts: 4;
}
```

Repair input and output tokens contribute to the current agent run's cumulative usage. Audit logs therefore retain cost and failure visibility while avoiding raw malformed arguments.

Add an agent event for visible repair progress:

```ts
{
  type: "structured-output-retry";
  tool: string;
  modelId: string;
  attempt: number;
  maxAttempts: number;
  delayMs: number;
  error: string;
}
```

The terminal renderer shows a compact repair/retry message. It must not render the raw JSON.

Retry status rows use a dedicated semantic presentation instead of the generic dimmed `info` style. Add a `retry` tone to transcript status blocks and render it with `ansi:yellowBright`. Apply this tone both to the existing `↻ Retrying model call · attempt 2/5 in 1s` row and to structured-output repair retries. Bright yellow makes transient recovery work visible without competing with failure red, success green, interactive cyan, or approval magenta. The retry text remains unchanged and the row continues to update in place.

## Tool runtime boundary

Add read-only methods that expose a tool's structured definition and validate input without side effects. Validation must not emit hooks, evaluate permissions, or run the tool. Execution continues to validate again as defense in depth.

Unknown tool names do not enter repair because there is no trusted target schema. They continue through the existing unknown-tool result path.

## Context and persistence

Repair prompts and malformed candidates are ephemeral and are not appended to the user's main conversation. Only the successfully repaired assistant tool call and its eventual tool result enter the main context. This prevents internal correction traffic from polluting future reasoning or session files.

If repair fails, the main conversation remains atomic: no partial assistant tool-call turn is persisted.

## Testing strategy

### Adapter regression tests

- Anthropic raw SSE containing inner tool JSON with `C:\Users` reaches Flavor Code and emits `invalid-tool-call` instead of throwing from the SDK accumulator.
- Valid Anthropic and OpenAI tool calls retain existing behavior.
- OpenAI malformed arguments preserve id, name, and raw input.
- Raw malformed inputs never appear in logged hook payloads.

### Structured-output unit tests

- A valid first response returns a typed Zod value.
- Invalid JSON feeds the exact parser error into the next prompt.
- Schema-invalid JSON feeds the Zod issue details into the next prompt.
- The wrapper performs one initial call plus exactly three retries.
- Retry delays are 1,000, 2,000, and 4,000 ms.
- Cancellation during backoff prevents further calls.
- Usage is accumulated across all attempts.
- Exhaustion returns `structured_output_error` without including raw input.

### Agent-loop integration tests

- The cheap model repairs an invalid main-model tool call and the tool executes once with corrected input.
- Existing assistant text is not regenerated or duplicated.
- A schema-valid main-model tool call does not invoke the cheap model.
- Multiple invalid calls are all repaired before any execution begins.
- Repair attempts emit hooks with purpose and attempt metadata.
- Terminal repair failure emits one final agent error and executes no tools.

### Terminal presentation tests

- Ordinary model retries create a status block with the `retry` tone.
- Structured-output repair retries use the same `retry` tone.
- `StatusLine` maps the retry tone to `ansi:yellowBright` without `dimColor`.
- Existing retry rows still update in place instead of adding one row per attempt.

### Verification commands

Run focused Vitest suites for model adapters, structured output, agent loop, UI transcript, and production audit behavior, followed by `npm test`, `npm run typecheck`, and `npm run build`.

## Compatibility

The ordinary `ModelAdapter.stream(ModelRequest)` contract remains source-compatible for plugins because the request shape is unchanged and new model events are additive. Built-in consumers must explicitly handle the new event variant. Existing network/rate-limit fallback remains separate from structured-output repair and retains its current behavior.
