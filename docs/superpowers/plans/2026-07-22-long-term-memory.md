# Long-Term Memory Implementation Plan

**Goal:** Add bounded, user-controlled, cross-session project memory without conflating it with conversation resume.

**Method:** TDD. Add focused failing tests for each behavior, implement the smallest coherent layer, then run the focused suite before proceeding.

## Task 1: File-backed memory domain

- Test canonical Markdown parsing/rendering, normalized IDs, de-duplication, bounds, unsafe-content rejection, forgetting, and concurrent mutations.
- Implement memory types, normalization, Markdown codec, and the protected project store.

## Task 2: Extraction and prompt context

- Test JSON extraction, filtering, prompt rules, and serialized best-effort queue behavior.
- Test memory ordering and persistence through `ContextManager` fork/compaction.
- Implement extractor, coordinator, and pinned memory context.

## Task 3: Configuration and management commands

- Test configuration defaults/bounds and `/memory`, `/remember`, `/forget` parsing and dispatch.
- Implement schema fields, service contracts, help text, and command behavior.

## Task 4: Production integration

- Test startup injection, cross-session automatic extraction, shutdown flushing, disabled behavior, and failure diagnostics.
- Load the store before context construction, create a no-tool subagent-model generator, track the extraction cursor, and wire lifecycle hooks.

## Task 5: Verification

- Run memory/config/context/session/production focused suites.
- Run `npm test`, `npm run typecheck`, and `npm run build`.
- Review the final diff for generated artifacts and unrelated changes.
