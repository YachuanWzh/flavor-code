# Multimodal Image Attachments Implementation Plan

## Task 1: Provider-neutral message blocks

- Add failing tests for text extraction, cloning, and image references.
- Add `ModelContent` and helpers while preserving string content.
- Update context estimation, compaction, and transcript hydration to use helpers.

## Task 2: Provider mappings

- Add failing OpenAI mapping tests.
- Implement async local-file loading and Responses image blocks.
- Add failing Anthropic mapping tests.
- Implement Messages base64 image blocks.
- Preserve existing text-only request shapes.

## Task 3: Session asset storage and persistence

- Add failing tests for validation, magic bytes, limits, atomic storage, and deduplication.
- Implement `SessionAssetStore`.
- Extend the session message schema for image metadata.
- Prove JSONL contains references but no base64 payload.

## Task 4: Submission path

- Add failing agent-loop tests for an initial multimodal user message.
- Add a structured user prompt at the desktop/session boundary.
- Keep routing, hooks, memory, skills, steering, and slash commands text-only.
- Persist and checkpoint using a textual transcript label.

## Task 5: Desktop IPC and composer

- Add failing contract tests for attachment payload limits.
- Add failing controller tests for storing and forwarding images.
- Implement preload/main/controller wiring.
- Add failing renderer tests for choose, paste, drop, remove, numbering, and send.
- Implement thumbnails and drag state with object URL cleanup.

## Task 6: Verification

- Run focused tests after each red/green cycle.
- Run all tests.
- Run `npm run typecheck`.
- Run `npm run build`.
- Inspect the final diff for accidental base64 persistence or text-only regressions.

## Task 7: Windows and macOS CLI clipboard images

- Add failing tests for raw Ctrl/Cmd+V and empty bracketed-paste detection.
- Add failing tests for the STA PowerShell clipboard adapter.
- Add failing tests for the macOS AppKit/JXA clipboard adapter and platform
  dispatch.
- Add failing tests for CLI image numbering, backspace removal, and
  image-only submission.
- Store extracted PNGs through `SessionAssetStore`.
- Keep ordinary text paste and queued text follow-ups unchanged.
- Run the complete verification matrix again.
