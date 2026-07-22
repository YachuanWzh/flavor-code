# Task-Level Long-Term Memory V2 Implementation Plan

**Goal:** Replace per-turn extraction with task-finalization, scored four-type memory artifacts, indexed storage, bounded hybrid retrieval, and task-level aging.

**Method:** TDD. Each layer starts with focused failing tests and is implemented before moving upward.

## Task 1: Scoring and similarity

- Specify strict scored extraction JSON, host-side threshold gates, candidate limits and sensitive-content filtering.
- Implement Unicode normalization, word/character n-grams, Jaccard and conservative duplicate bands.

## Task 2: V2 index and task files

- Specify index/task Markdown round trips, safe paths, exact CRUD, migration and concurrent confirmation.
- Implement one task file per finalized task and one index reference per typed item.

## Task 3: Retrieval and aging

- Specify mixed lexical ranking, type/heat weights, Top K and character budgets.
- Implement task-deduplicated recall counts and deterministic hot/cold classification.

## Task 4: Task lifecycle

- Specify session lifecycle metadata and `/finish` idempotency.
- Remove per-Stop extraction and finalize only through explicit task completion.

## Task 5: CLI and Electron

- Add completion controls and retain the existing non-blocking review surfaces.
- Show related-memory hints without allowing renderer-controlled paths.

## Task 6: Documentation and verification

- Update README and the technical design report with plain-language flows and Mermaid diagrams.
- Bump package metadata to 1.0.1.
- Run focused tests, full tests, typecheck, complete build and diff checks.

## Task 7: Explicit natural-language remember intent

- Detect affirmative remember phrases locally while rejecting negation, recall questions and `/remember`.
- Let the cheap model extract only the explicitly requested durable fact, then write directly through the same safety, deduplication and V2 storage layers.
