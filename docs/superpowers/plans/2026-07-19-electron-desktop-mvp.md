# Flavor Code Electron Desktop MVP Implementation Plan

> **For agentic workers:** Execute inline with test-driven development. Do not create commits.

**Goal:** Deliver a packaged Electron MVP that exposes Flavor Code's existing runtime in a Codex-inspired desktop interface.

**Architecture:** Electron main owns a testable runtime controller and exposes a narrow, validated IPC contract through a context-isolated preload. A Vite-built React renderer reuses the existing transcript reducer and renders runtime events, approvals, questions, sessions and slash-command access.

**Tech Stack:** Electron, React 19, React DOM, Vite, TypeScript, Zod, Vitest, electron-builder.

## Global Constraints

- Do not commit, stage, push or create a branch.
- Preserve all existing CLI behavior and tests.
- Keep `contextIsolation: true`, `nodeIntegration: false`, and expose no generic IPC API.
- Support Windows packaging first while keeping development runnable on other Electron platforms.

---

### Task 1: Desktop contracts and runtime controller

**Files:**
- Create: `src/desktop/contracts.ts`
- Create: `src/desktop/runtime-controller.ts`
- Test: `tests/desktop/contracts.test.ts`
- Test: `tests/desktop/runtime-controller.test.ts`

**Interfaces:**
- `DesktopRuntimeController.openWorkspace(path): Promise<DesktopSnapshot>`
- `DesktopRuntimeController.startSession(resumeSession?): Promise<SessionStartedPayload>`
- `DesktopRuntimeController.submit(prompt): Promise<void>`
- `DesktopRuntimeController.interrupt(): Promise<void>`
- `DesktopRuntimeController.resolveApproval(decision): void`
- `DesktopRuntimeController.answerQuestions(answers): void`

- [ ] Write schema and lifecycle tests; run them and confirm failure because desktop modules do not exist.
- [ ] Implement serializable contracts and the controller using dependency injection for runtime/session stores.
- [ ] Run the focused tests and confirm they pass.

### Task 2: Secure Electron shell

**Files:**
- Create: `src/desktop/main.ts`
- Create: `src/desktop/preload.ts`
- Create: `src/desktop/global.d.ts`
- Test: `tests/desktop/preload-contract.test.ts`

**Interfaces:**
- `window.flavorDesktop` exposes explicit request methods and an `onEvent` unsubscribe function.

- [ ] Write a test asserting the public channel allow-list and safe URL validation; confirm it fails.
- [ ] Implement the main window, folder picker, userData persistence, IPC validation, URL policy and preload bridge.
- [ ] Run focused tests and confirm they pass.

### Task 3: Renderer state and Codex-inspired interface

**Files:**
- Create: `src/desktop/renderer/index.html`
- Create: `src/desktop/renderer/main.tsx`
- Create: `src/desktop/renderer/app.tsx`
- Create: `src/desktop/renderer/view-model.ts`
- Create: `src/desktop/renderer/styles.css`
- Test: `tests/desktop/view-model.test.ts`

**Interfaces:**
- Renderer consumes `DesktopEvent` and invokes only `window.flavorDesktop`.
- `groupSessions()` produces dated project-session sections; `permissionLabel()` maps all six modes.

- [ ] Write view-model tests for session labels, permission labels and event-derived transcript completion; confirm they fail.
- [ ] Implement the view helpers and React UI for rail, conversation, task/tool cards, composer, approval/question sheets and settings popovers.
- [ ] Implement responsive, keyboard-focus and reduced-motion styles from the design spec.
- [ ] Run focused tests and confirm they pass.

### Task 4: Build, packaging and documentation

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `tsup.config.ts`
- Create: `vite.desktop.config.ts`
- Modify: `README.md`

- [ ] Add Electron, React DOM, Vite and electron-builder dependencies plus `desktop:dev`, `desktop:build`, `desktop:pack` and combined build scripts.
- [ ] Configure main/preload output and renderer base paths so packaged loading works.
- [ ] Document source and packaged desktop commands.
- [ ] Run `npm test`, `npm run typecheck`, `npm run build` and an unpacked Windows package build.
- [ ] Launch the packaged app, capture desktop and narrow screenshots, and correct any visual/runtime defects before handoff.

