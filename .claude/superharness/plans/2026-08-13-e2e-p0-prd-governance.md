# E2E P0 PRD Governance Implementation Plan

> **For agentic workers:** Execute this plan task-by-task under the superharness:go workflow, Phase 2 (strict TDD per task). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build immutable approved-PRD governance, traceable acceptance evidence, a versioned seven-node delivery run, crash-safe CAS persistence, and a real Electron smoke suite.

**Architecture:** Keep current product/workflow JSON files as compatibility views and add focused `prd-governance`, `delivery-run`, and `acceptance-baseline` modules. All state mutations use expected revisions and artifact hashes; controller entry points validate the approved PRD before consuming downstream artifacts. Renderer APIs expose PRD section mutation without allowing post-approval writes.

**Tech Stack:** TypeScript 7, Zod 4, Vitest 4, React 19, Electron 42, playwright-core.

---

### Task 1: PRD governance domain

**Files:**
- Create: `src/e2e/prd-governance.ts`
- Test: `tests/e2e/prd-governance.test.ts`

- [ ] **Step 1: Write failing tests** for `parsePrdSections`, `replacePrdSection`, `extractAcceptanceCriteria`, `approvePrd`, and `assertApprovedPrd` using real temporary files and expected hashes.
- [ ] **Step 2: Run RED** with `npx vitest run tests/e2e/prd-governance.test.ts`; expect missing-module failure.
- [ ] **Step 3: Implement minimal domain functions** with SHA-256 optimistic edit checking, unique `[AC-NNN]` validation, and `PRD_LOCK_VIOLATION` errors.
- [ ] **Step 4: Run GREEN** with the same command; expect all PRD governance tests to pass.

### Task 2: Seven-node delivery run and protected CAS store

**Files:**
- Create: `src/e2e/delivery-run.ts`
- Create: `tests/e2e/delivery-run.test.ts`
- Modify: `src/config/protected-file.ts`
- Modify: `tests/config/protected-file.test.ts`

- [ ] **Step 1: Write failing tests** for dependency enforcement, attempts, transitive stale propagation, expectedRevision conflict, backup recovery, and simulated Windows rename failure.
- [ ] **Step 2: Run RED** with `npx vitest run tests/e2e/delivery-run.test.ts tests/config/protected-file.test.ts`; expect missing APIs/assertion failures.
- [ ] **Step 3: Implement minimal delivery run schema and mutation functions**, persisting through `updateProtectedFile`; enhance atomic replacement with safe copy fallback for Windows sharing errors.
- [ ] **Step 4: Run GREEN** and keep the protected-file regression suite passing.

### Task 3: PRD product state, IPC, and renderer editing

**Files:**
- Modify: `src/d2c/product.ts`
- Modify: `src/desktop/contracts.ts`
- Modify: `src/desktop/channels.ts`
- Modify: `src/desktop/preload.ts`
- Modify: `src/desktop/main.ts`
- Modify: `src/desktop/runtime-controller.ts`
- Modify: `src/desktop/renderer/d2c-viewer.tsx`
- Modify: `src/desktop/renderer/styles.css`
- Modify: `tests/d2c/product.test.ts`
- Modify: `tests/desktop/contracts.test.ts`
- Modify: `tests/desktop/d2c-workflow-controller.test.ts`
- Modify: `tests/desktop/d2c-viewer.test.ts`

- [ ] **Step 1: Write failing tests** proving regeneration query returns a scoped prompt, section edits require current hash, PRD approval stores immutable metadata, controller rejects post-approval drift, and renderer source exposes section edit/save controls.
- [ ] **Step 2: Run RED** on the four focused test files and confirm failures are caused by missing APIs/metadata.
- [ ] **Step 3: Implement minimal product/controller/IPC behavior** and a section editor that edits only one parsed Markdown section.
- [ ] **Step 4: Run GREEN** on the focused product and desktop tests.

### Task 4: Workflow CAS, pure reads, and artifact invalidation

**Files:**
- Modify: `src/d2c/workflow.ts`
- Modify: `src/desktop/runtime-controller.ts`
- Modify: `tests/d2c/workflow.test.ts`
- Modify: `tests/desktop/d2c-workflow-controller.test.ts`

- [ ] **Step 1: Write failing tests** proving reads do not increment revision, stale expected revisions fail, each mutation increments once, corrupt primary recovers from backup, and a new D2C artifact invalidates API/interaction/quality descendants.
- [ ] **Step 2: Run RED** and verify the current unconditional `writeWorkflow` behavior fails these assertions.
- [ ] **Step 3: Replace direct writes with locked `updateWorkflow` CAS mutations**, retain `writeWorkflow` only as a compatibility create/replace wrapper, and remove writes from report reads when state is unchanged.
- [ ] **Step 4: Run GREEN** on workflow and controller tests.

### Task 5: Strict multi-document acceptance

**Files:**
- Create: `src/e2e/acceptance-baseline.ts`
- Create: `tests/e2e/acceptance-baseline.test.ts`
- Modify: `src/d2c/interaction.ts`
- Modify: `src/desktop/runtime-controller.ts`
- Modify: `tests/d2c/interaction.test.ts`
- Modify: `tests/desktop/d2c-workflow-controller.test.ts`

- [ ] **Step 1: Write failing tests** for `requirementIds`, full criterion coverage, unknown IDs, artifact drift, and acceptance evidence generation.
- [ ] **Step 2: Run RED** and confirm strict schemas/coverage APIs are absent.
- [ ] **Step 3: Implement baseline capture and verification**, extend normalized interaction manifests with requirement IDs, block design confirmation and automated acceptance on incomplete coverage or stale PRD/design/interaction/OpenAPI artifacts, and persist criterion-to-scenario results.
- [ ] **Step 4: Run GREEN** on acceptance, interaction, and controller tests.

### Task 6: Real Electron application E2E and final verification

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `tests/desktop/electron-app.e2e.mjs`

- [ ] **Step 1: Add the real Electron test first** using `playwright-core` to launch the built app, click the E2E rail action, and assert the seven-stage UI.
- [ ] **Step 2: Run RED** with `npm run test:desktop:e2e`; expect missing dependency/script or launch assertion failure.
- [ ] **Step 3: Install `playwright-core` and add the isolated build-and-run script**, using a temporary userData directory and guaranteed process cleanup.
- [ ] **Step 4: Run focused suites**, then `npm test`, `npm run typecheck`, `npm run build:desktop`, and `npm run test:desktop:e2e`; require zero failures before completion.

## Self-review

- Spec coverage: regeneration, section editing, immutable confirmation, four-document acceptance, node invalidation, CAS/recovery, and real Electron testing are each mapped to a task.
- Placeholder scan: no deferred implementation placeholders are used.
- Type consistency: approved PRD metadata, artifact references, expected revisions, and requirement IDs use the same names throughout the plan.
