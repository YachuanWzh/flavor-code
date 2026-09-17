import { execFileNoThrow } from "../utils/execFileNoThrow.js";
import { DEFAULT_MAX_IMAGE_BYTES, type ImageAttachmentInput } from "../session/assets.js";

const CLIPBOARD_TIMEOUT_MS = 10_000;
const NO_IMAGE_EXIT_CODE = 3;
const NO_TEXT_EXIT_CODE = 3;
// Image adapters emit base64 (~4/3 of the PNG bytes). Node's 1 MiB
// execFile default rejects ordinary screenshots before asset validation.
const CLIPBOARD_IMAGE_MAX_BUFFER = Math.ceil(DEFAULT_MAX_IMAGE_BYTES / 3) * 4 + 64 * 1024;

const READ_WINDOWS_CLIPBOARD_TEXT = String.raw`
Add-Type -AssemblyName System.Windows.Forms
if (-not [Windows.Forms.Clipboard]::ContainsText()) { exit 3 }
$text = [Windows.Forms.Clipboard]::GetText()
if ([string]::IsNullOrEmpty($text)) { exit 3 }
$bytes = [System.Text.Encoding]::UTF8.GetBytes($text)
[Console]::Out.Write([Convert]::ToBase64String($bytes))
`.trim();

const READ_WINDOWS_CLIPBOARD_IMAGE = String.raw`
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$image = [Windows.Forms.Clipboard]::GetImage()
if ($null -eq $image) { exit 3 }
$stream = New-Object System.IO.MemoryStream
try {
  $image.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
  [Console]::Out.Write([Convert]::ToBase64String($stream.ToArray()))
} finally {
  $stream.Dispose()
  $image.Dispose()
}
`.trim();

// JXA bridges ObjC nil inconsistently across macOS versions: some return
// JavaScript null (falsy), others an $.nil proxy that is truthy yet resolves
// every method lookup to undefined. Guard every bridge object by probing the
// method we are about to call, and fail soft to exit(3) ("no image") so the
// caller falls back to a plain text paste instead of surfacing a TypeError.
const READ_MAC_CLIPBOARD_IMAGE = String.raw`
ObjC.import("AppKit");
ObjC.import("Foundation");
ObjC.import("stdlib");

function isBridgeMethod(value, method) {
  return value !== null && value !== undefined
    && typeof value[method] === "function";
}

try {
  const pasteboard = $.NSPasteboard.generalPasteboard;
  let data = null;
  if (isBridgeMethod(pasteboard, "dataForType")) {
    const png = pasteboard.dataForType($.NSPasteboardTypePNG);
    if (isBridgeMethod(png, "base64EncodedStringWithOptions")) {
      data = png;
    } else {
      const tiff = pasteboard.dataForType($.NSPasteboardTypeTIFF);
      // NSData.length is exposed by JXA as a property value, not a
      // callable bridge method. Probe a real NSData method so a valid
      // TIFF-only pasteboard item is not mistaken for ObjC nil.
      if (isBridgeMethod(tiff, "base64EncodedStringWithOptions")) {
        const representation = $.NSBitmapImageRep.imageRepWithData(tiff);
        if (isBridgeMethod(representation, "representationUsingTypeProperties")) {
          const converted = representation.representationUsingTypeProperties(
            $.NSBitmapImageFileTypePNG,
            $.NSDictionary.dictionary
          );
          if (isBridgeMethod(converted, "base64EncodedStringWithOptions")) {
            data = converted;
          }
        }
      }
    }
  }
  if (!data) {
    $.exit(3);
  }
  const encoded = data.base64EncodedStringWithOptions(0);
  if (!encoded) {
    $.exit(3);
  }
  const output = encoded.stringByAppendingString("\n")
    .dataUsingEncoding($.NSUTF8StringEncoding);
  $.NSFileHandle.fileHandleWithStandardOutput.writeData(output);
} catch (error) {
  $.exit(3);
}
`.trim();

type ClipboardRunner = typeof execFileNoThrow;

export interface ClipboardImageReadOptions {
  platform?: NodeJS.Platform | string;
  run?: ClipboardRunner;
  now?: () => Date;
}

export type ClipboardPasteIntent = "immediate" | "deferred";

/** Native fallback waits for terminal-delivered bracketed text first. */
export function clipboardPasteIntent(
  input: string,
  key: { ctrl: boolean; super?: boolean },
  isPasted: boolean,
  platform: NodeJS.Platform | string = process.platform,
): ClipboardPasteIntent | undefined {
  if (isPasted) return input.length === 0 ? "immediate" : undefined;
  const pasteModifier = platform === "darwin" ? key.super === true : key.ctrl;
  return pasteModifier && input.toLowerCase() === "v" ? "deferred" : undefined;
}

export type ClipboardContent =
  | { kind: "text"; text: string }
  | { kind: "image"; attachment: ImageAttachmentInput };

/** Standard paste is text-first; an image is attached only when text is absent. */
export async function readClipboardContent(
  options: ClipboardImageReadOptions = {},
): Promise<ClipboardContent | undefined> {
  const text = await readClipboardText(options);
  if (text !== undefined) return { kind: "text", text };
  const attachment = await readClipboardImage(options);
  return attachment === undefined ? undefined : { kind: "image", attachment };
}

export async function readClipboardText(
  options: ClipboardImageReadOptions = {},
): Promise<string | undefined> {
  const platform = options.platform ?? process.platform;
  if (platform === "win32") return readWindowsClipboardText({ ...options, platform });
  if (platform === "darwin") return readMacClipboardText({ ...options, platform });
  throw new Error("Pasting native clipboard content is currently supported on Windows and macOS only");
}

export async function readWindowsClipboardText(
  options: ClipboardImageReadOptions = {},
): Promise<string | undefined> {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") throw new Error("Reading clipboard text this way is supported on Windows only");
  const result = await (options.run ?? execFileNoThrow)(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-STA", "-Command", READ_WINDOWS_CLIPBOARD_TEXT],
    { timeout: CLIPBOARD_TIMEOUT_MS, useCwd: false },
  );
  if (result.code === NO_TEXT_EXIT_CODE) return undefined;
  if (result.code !== 0) throw clipboardReadError("text", result);
  const encoded = result.stdout.trim();
  if (encoded.length === 0) return undefined;
  return Buffer.from(encoded, "base64").toString("utf8") || undefined;
}

export async function readMacClipboardText(
  options: ClipboardImageReadOptions = {},
): Promise<string | undefined> {
  const platform = options.platform ?? process.platform;
  if (platform !== "darwin") throw new Error("Reading clipboard text this way is supported on macOS only");
  const result = await (options.run ?? execFileNoThrow)(
    "pbpaste",
    ["-Prefer", "txt"],
    { timeout: CLIPBOARD_TIMEOUT_MS, useCwd: false },
  );
  if (result.code !== 0 || result.stdout.length === 0) return undefined;
  return result.stdout;
}

export async function readClipboardImage(
  options: ClipboardImageReadOptions = {},
): Promise<ImageAttachmentInput | undefined> {
  const platform = options.platform ?? process.platform;
  if (platform === "win32") return readWindowsClipboardImage({ ...options, platform });
  if (platform === "darwin") return readMacClipboardImage({ ...options, platform });
  throw new Error("Pasting clipboard images is currently supported on Windows and macOS only");
}

export async function readWindowsClipboardImage(
  options: ClipboardImageReadOptions = {},
): Promise<ImageAttachmentInput | undefined> {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") {
    throw new Error("Pasting clipboard images is currently supported on Windows only");
  }

  const result = await (options.run ?? execFileNoThrow)(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-STA", "-Command", READ_WINDOWS_CLIPBOARD_IMAGE],
    { timeout: CLIPBOARD_TIMEOUT_MS, useCwd: false, maxBuffer: CLIPBOARD_IMAGE_MAX_BUFFER },
  );
  return attachmentFromResult(result, options.now?.() ?? new Date());
}

export async function readMacClipboardImage(
  options: ClipboardImageReadOptions = {},
): Promise<ImageAttachmentInput | undefined> {
  const platform = options.platform ?? process.platform;
  if (platform !== "darwin") {
    throw new Error("Pasting clipboard images through AppKit is supported on macOS only");
  }

  const result = await (options.run ?? execFileNoThrow)(
    "osascript",
    ["-l", "JavaScript", "-e", READ_MAC_CLIPBOARD_IMAGE],
    { timeout: CLIPBOARD_TIMEOUT_MS, useCwd: false, maxBuffer: CLIPBOARD_IMAGE_MAX_BUFFER },
  );
  return attachmentFromResult(result, options.now?.() ?? new Date());
}

function attachmentFromResult(
  result: Awaited<ReturnType<ClipboardRunner>>,
  now: Date,
): ImageAttachmentInput | undefined {
  if (result.code === NO_IMAGE_EXIT_CODE) return undefined;
  if (result.code !== 0) {
    throw clipboardReadError("image", result);
  }

  const dataBase64 = result.stdout.trim();
  if (dataBase64.length === 0) return undefined;
  return {
    name: `clipboard-${timestamp(now)}.png`,
    mediaType: "image/png",
    dataBase64,
  };
}

function clipboardReadError(
  kind: "text" | "image",
  result: { stderr: string; error?: string },
): Error {
  const detail = result.stderr.trim() || result.error?.trim();
  return new Error(detail
    ? `Could not read the clipboard ${kind}: ${detail}`
    : `Could not read the clipboard ${kind}`);
}

function timestamp(value: Date): string {
  const year = value.getUTCFullYear();
  const month = String(value.getUTCMonth() + 1).padStart(2, "0");
  const day = String(value.getUTCDate()).padStart(2, "0");
  const hour = String(value.getUTCHours()).padStart(2, "0");
  const minute = String(value.getUTCMinutes()).padStart(2, "0");
  const second = String(value.getUTCSeconds()).padStart(2, "0");
  return `${year}${month}${day}-${hour}${minute}${second}`;
}
