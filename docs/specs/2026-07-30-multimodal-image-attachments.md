# Multimodal Image Attachments MVP

## Goal

Allow users of the Electron desktop client and terminal CLI to attach
screenshots or image files to a normal coding-agent prompt and send the prompt
directly to an image-capable OpenAI- or Anthropic-compatible model.

The interaction should feel like Claude Code: paste, drop, or choose images; see numbered image chips before sending; remove an image; and see the same numbered references in the submitted turn.

## Scope

The MVP includes:

- PNG, JPEG, and WebP images.
- Up to five images per prompt.
- A 5 MiB encoded-file limit per image and a 20 MiB total limit per submission.
- Desktop file selection, clipboard paste, and drag-and-drop.
- Windows and macOS CLI clipboard-image paste through the platform paste
  shortcut, a raw shortcut event, or an empty bracketed-paste event emitted by
  the terminal.
- Content-addressed storage below `.flavor/session-assets/<session-id>/`.
- Provider-neutral text and image content blocks.
- OpenAI Responses API and Anthropic Messages API mappings.
- Session persistence and restore without embedding base64 data in JSONL.
- Numbered `[Image #n]` references in the transcript.
- Explicit validation errors for unsupported media, invalid base64, missing asset files, and exceeded limits.

The MVP does not include:

- PKCE gateway changes.
- RAG ingestion, OCR, embeddings, or cross-session image search.
- Image generation.
- VS Code image paste.
- HEIC, SVG, animated-image handling, image editing, or automatic model capability discovery.
- Image attachments on slash commands, steering messages, or queued follow-ups.

## Product behavior

1. The attachment button opens the native browser file picker.
2. Pasting an image while the composer is focused adds it instead of inserting binary clipboard content.
3. Dropping image files on the composer adds them and gives visible drag feedback.
4. Pending images appear above the textarea in selection order as `[Image #1]`, `[Image #2]`, and so on, with a thumbnail and remove button.
5. A prompt may contain only images; its model-visible text becomes `Analyze the attached image(s).`
6. Sending optimistically creates a transcript turn whose prompt contains the text followed by the numbered image references.
7. Attachments are cleared only after IPC accepts the submission. Validation or IPC failure leaves them available for retry.
8. Images cannot be attached to slash commands, steering messages, or follow-ups in this MVP.

### Windows and macOS CLI behavior

1. While the CLI prompt is idle, `Ctrl+V` on Windows or `Cmd+V` on macOS
   attempts to read an image directly from the system clipboard. Flavor handles
   both a raw shortcut event and an empty bracketed-paste event because terminal
   hosts differ in how they represent a clipboard image.
2. Windows clipboard access runs in an isolated STA PowerShell process and
   converts the clipboard bitmap to PNG bytes in memory.
3. macOS clipboard access runs in an isolated JavaScript for Automation process
   through `osascript`, reads AppKit PNG data, and converts TIFF-only clipboard
   images to PNG in memory.
4. A successful paste stores the PNG through `SessionAssetStore` and renders
   `[Image #n] <name>` above the terminal prompt.
5. Normal text paste continues unchanged. Flavor only probes for an image when
   the paste is empty or a raw paste shortcut is received.
6. Backspace on an empty prompt removes the most recent image.
7. Enter submits text plus images. An image-only submission uses
   `Analyze the attached image(s).`
8. CLI images cannot be attached to a slash command or to a running task's
   steering/follow-up message.
9. Other platforms receive a concise unsupported-platform message until a
   native adapter is added.

## Architecture

### IPC input

The renderer sends transient attachment inputs:

```ts
interface DesktopImageAttachmentInput {
  name: string;
  mediaType: "image/png" | "image/jpeg" | "image/webp";
  dataBase64: string;
}
```

The payload is validated in the Electron main process. Base64 exists only in the renderer-to-main IPC call and is never persisted in the session document.

### Asset store

`SessionAssetStore` validates the decoded magic bytes, hashes the bytes with SHA-256, and atomically writes:

```text
.flavor/session-assets/<session-id>/<sha256>.<extension>
```

The store returns a provider-neutral image block containing the absolute asset path, media type, hash, byte size, and original display name. Repeated bytes in the same session reuse the existing file.

### Model messages

Existing string content remains valid for compatibility:

```ts
type ModelContent = string | ModelContentBlock[];

type ModelContentBlock =
  | { type: "text"; text: string }
  | {
      type: "image";
      source: { type: "file"; path: string };
      mediaType: "image/png" | "image/jpeg" | "image/webp";
      sha256: string;
      bytes: number;
      name?: string;
    };
```

Only user messages may contain image blocks. System, assistant, and tool messages remain text in this MVP.

Helpers provide:

- model-visible text for planning, hooks, memory routing, transcript labels, token estimates, and compaction;
- deep cloning of content blocks;
- image detection and a stable `[Image #n]` textual representation.

The agent loop accepts an optional initial user message. All text-only routing continues to use the prompt text, while the main context receives the multimodal message.

### Provider mapping

OpenAI user content maps to:

```ts
[
  { type: "input_text", text: "..." },
  { type: "input_image", image_url: "data:image/png;base64,...", detail: "auto" }
]
```

Anthropic user content maps to:

```ts
[
  { type: "text", text: "..." },
  {
    type: "image",
    source: { type: "base64", media_type: "image/png", data: "..." }
  }
]
```

Adapters read the validated local asset immediately before creating the provider request. Missing or changed files fail the call; images are never silently dropped.

### Persistence and compaction

Session JSONL persists image metadata and local paths, not bytes. Existing string-only sessions continue to load unchanged.

Token estimation charges a bounded placeholder cost for image blocks. Compaction summaries receive textual image references, not binary data. Recent uncompacted turns retain their image blocks so follow-up questions can still refer to the image.

## Security and limits

- Strict IPC schemas reject unknown fields.
- Media type must be allowlisted and match magic bytes.
- Asset paths are generated by the main process, never accepted from the renderer.
- Base64 must decode canonically and cannot exceed configured limits.
- Asset directories and files use private permissions where the platform supports them.
- Writes are atomic and content-addressed.
- Renderer object URLs are revoked when attachments are removed, sent, or the component unmounts.

## Acceptance criteria

1. Existing text-only model requests remain byte-for-byte equivalent.
2. Unit tests prove OpenAI and Anthropic receive their expected image block formats.
3. Unit tests prove attachment bytes are stored outside session JSONL and deduplicated.
4. Unit tests prove legacy string messages round-trip.
5. Contract tests reject invalid media, malformed base64, more than five images, oversized images, and attachments on non-prompt delivery.
6. Renderer tests prove image chips are numbered, removable, and included in the submitted transcript label.
7. The full test suite, typecheck, CLI build, and desktop build pass.
