# Resume Conversation History Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Hydrate the interactive transcript with retained user and assistant messages when the CLI starts with `--resume`.

**Architecture:** The production runtime exposes a minimal read-only projection of messages loaded from a resumed session. The transcript reducer owns a pure hydration conversion, and the interactive app dispatches it before starting the restored session; live output and print mode remain unchanged.

**Tech Stack:** TypeScript, React, Ink, Vitest

## Global Constraints

- Display user prompts and assistant text only; never replay tool messages, task rows, notices, or usage rows.
- Display only retained `conversation.messages`; do not render compact summaries as original history.
- Do not change the session file format, model context restoration, print-mode output, or scrolling behavior.
- Follow red-green-refactor and run each targeted test in isolation before the full suite.

---

### Task 1: Transcript History Hydration

**Files:**
- Modify: `tests/ui/transcript.test.ts`
- Modify: `src/ui/transcript.ts`
- Test: `tests/ui/transcript.test.ts`

**Interfaces:**
- Consumes: `readonly TranscriptHistoryMessage[]`, where each message has `role: "user" | "assistant" | "tool"` and `content: string`.
- Produces: `TranscriptAction` variant `{ type: "hydrate"; messages: readonly TranscriptHistoryMessage[] }` and a `TranscriptState` containing only completed historical turns.

- [ ] **Step 1: Write failing reducer tests**

Add this test:

```ts
it("hydrates retained user and assistant turns without tool output", () => {
  const state = transcriptReducer(createTranscriptState(), { type: "hydrate", messages: [
    { role: "user", content: "first question" },
    { role: "assistant", content: "checking" },
    { role: "tool", content: "very long tool output" },
    { role: "assistant", content: "first answer" },
    { role: "assistant", content: "" },
    { role: "user", content: "second question" },
  ] });

  expect(state.completed.map(({ id, prompt, assistantText, blocks }) => ({ id, prompt, assistantText, blocks }))).toEqual([
    { id: 1, prompt: "first question", assistantText: "checkingfirst answer", blocks: [{ kind: "text", text: "checkingfirst answer" }] },
    { id: 2, prompt: "second question", assistantText: "", blocks: [] },
  ]);
  expect(state.active).toBeUndefined();
  expect(state.nextId).toBe(3);
  expect(JSON.stringify(state)).not.toContain("very long tool output");
});
```

- [ ] **Step 2: Run the test and verify RED**

Run: `npm test -- tests/ui/transcript.test.ts`

Expected: FAIL because `"hydrate"` is not assignable to `TranscriptAction` or is not handled by the reducer.

- [ ] **Step 3: Implement minimal hydration**

In `src/ui/transcript.ts`, add the type and action:

```ts
export interface TranscriptHistoryMessage {
  readonly role: "user" | "assistant" | "tool";
  readonly content: string;
}

// Add to TranscriptAction:
| { type: "hydrate"; messages: readonly TranscriptHistoryMessage[] }
```

Handle the action before live session-event processing and add this conversion:

```ts
function hydrateHistory(messages: readonly TranscriptHistoryMessage[]): TranscriptState {
  const completed: TranscriptTurn[] = [];
  let turn: TranscriptTurn | undefined;
  for (const message of messages) {
    if (message.role === "user") {
      if (turn !== undefined) completed.push(turn);
      turn = {
        id: completed.length + 1,
        prompt: message.content,
        assistantText: "",
        statusLines: [],
        blocks: [],
      };
    } else if (message.role === "assistant" && message.content.length > 0 && turn !== undefined) {
      turn = addText(turn, message.content);
    }
  }
  if (turn !== undefined) completed.push(turn);
  return { completed, nextId: completed.length + 1 };
}
```

- [ ] **Step 4: Run the targeted test and verify GREEN**

Run: `npm test -- tests/ui/transcript.test.ts`

Expected: PASS with all transcript reducer tests green.

- [ ] **Step 5: Commit the transcript unit**

```bash
git add src/ui/transcript.ts tests/ui/transcript.test.ts
git commit -m "feat(ui): hydrate restored conversation turns"
```

### Task 2: Runtime-to-UI Restored History Boundary

**Files:**
- Modify: `tests/cli/production.test.ts`
- Modify: `tests/ui/app-render.test.tsx`
- Modify: `src/production.ts`
- Modify: `src/ui/app.tsx`
- Test: `tests/cli/production.test.ts`
- Test: `tests/ui/app-render.test.tsx`

**Interfaces:**
- Consumes: the resumed `SessionDocument["conversation"]["messages"]` already loaded by `createProductionRuntime`.
- Produces: `ProductionRuntime.restoredMessages: readonly TranscriptHistoryMessage[]`, empty for fresh sessions; the app dispatches `{ type: "hydrate", messages: created.restoredMessages }` before `created.session.start()`.

- [ ] **Step 1: Write failing runtime and rendering tests**

Extend the existing planned-session fixture with these messages and assert the restored projection:

```ts
expect(resumed.restoredMessages).toEqual([
  { role: "user", content: "persist me" },
  { role: "assistant", content: "persisted answer" },
  { role: "tool", content: "hidden tool output" },
]);
expect(fresh.restoredMessages).toEqual([]);
```

Add an Ink rendering test with this core:

```tsx
const state = transcriptReducer(createTranscriptState(), { type: "hydrate", messages: [
  { role: "user", content: "restored question" },
  { role: "assistant", content: "restored answer" },
  { role: "tool", content: "hidden tool output" },
] });
const output = renderToString(<TerminalLayout
  model="model" workspaceName="workspace" completed={state.completed}
  input="" promptCursor={0} columns={80} activeSession={false}
/>, { columns: 80 });
expect(output).toContain("restored question");
expect(output).toContain("restored answer");
expect(output).not.toContain("hidden tool output");
```

- [ ] **Step 2: Run both tests and verify RED**

Run: `npm test -- tests/cli/production.test.ts tests/ui/app-render.test.tsx`

Expected: FAIL because `ProductionRuntime.restoredMessages` does not exist and the app cannot hydrate restored turns.

- [ ] **Step 3: Expose and wire restored messages**

Add this minimal message type/property to `ProductionRuntime`:

```ts
export interface RestoredConversationMessage {
  readonly role: "user" | "assistant" | "tool";
  readonly content: string;
}

export interface ProductionRuntime {
  // existing properties
  restoredMessages: readonly RestoredConversationMessage[];
}
```

Before returning the runtime, create and expose the projection:

```ts
const restoredMessages: readonly RestoredConversationMessage[] = recovered?.conversation.messages
  .map(({ role, content }) => ({ role, content })) ?? [];

return {
  session, services, approvals, restoredMessages,
  // existing getters and dispose implementation
};
```

Update `App` after runtime creation:

```ts
dispatch({ type: "hydrate", messages: created.restoredMessages });
runtimeRef.current = created;
```

Keep `runPrint` unchanged so resumed history is not written to stdout.

- [ ] **Step 4: Run targeted tests and typecheck**

Run: `npm test -- tests/cli/production.test.ts tests/ui/app-render.test.tsx && npm run typecheck`

Expected: PASS with no TypeScript errors.

- [ ] **Step 5: Run full verification**

Run: `npm test && npm run build`

Expected: all Vitest tests pass and the tsup build exits successfully.

- [ ] **Step 6: Commit the integration**

```bash
git add src/production.ts src/ui/app.tsx tests/cli/production.test.ts tests/ui/app-render.test.tsx
git commit -m "fix(ui): show conversation history on resume"
```
