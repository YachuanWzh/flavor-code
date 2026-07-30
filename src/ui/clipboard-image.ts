import { execFileNoThrow } from "../utils/execFileNoThrow.js";
import type { ImageAttachmentInput } from "../session/assets.js";

const CLIPBOARD_TIMEOUT_MS = 10_000;
const NO_IMAGE_EXIT_CODE = 3;

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

const READ_MAC_CLIPBOARD_IMAGE = String.raw`
ObjC.import("AppKit");
ObjC.import("Foundation");
ObjC.import("stdlib");

const pasteboard = $.NSPasteboard.generalPasteboard;
let data = pasteboard.dataForType($.NSPasteboardTypePNG);
if (!data) {
  const tiff = pasteboard.dataForType($.NSPasteboardTypeTIFF);
  if (tiff) {
    const representation = $.NSBitmapImageRep.imageRepWithData(tiff);
    if (representation) {
      data = representation.representationUsingTypeProperties(
        $.NSBitmapImageFileTypePNG,
        $({})
      );
    }
  }
}
if (!data) {
  $.exit(3);
}
const encoded = data.base64EncodedStringWithOptions(0);
console.log(ObjC.unwrap(encoded));
`.trim();

type ClipboardRunner = typeof execFileNoThrow;

export interface ClipboardImageReadOptions {
  platform?: NodeJS.Platform | string;
  run?: ClipboardRunner;
  now?: () => Date;
}

export function shouldReadClipboardImage(
  input: string,
  key: { ctrl: boolean; meta?: boolean },
  isPasted: boolean,
): boolean {
  return ((key.ctrl || key.meta === true) && input.toLowerCase() === "v")
    || (isPasted && input.length === 0);
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
    { timeout: CLIPBOARD_TIMEOUT_MS, useCwd: false },
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
    { timeout: CLIPBOARD_TIMEOUT_MS, useCwd: false },
  );
  return attachmentFromResult(result, options.now?.() ?? new Date());
}

function attachmentFromResult(
  result: Awaited<ReturnType<ClipboardRunner>>,
  now: Date,
): ImageAttachmentInput | undefined {
  if (result.code === NO_IMAGE_EXIT_CODE) return undefined;
  if (result.code !== 0) {
    const detail = result.stderr.trim() || result.error?.trim();
    throw new Error(detail
      ? `Could not read the clipboard image: ${detail}`
      : "Could not read the clipboard image");
  }

  const dataBase64 = result.stdout.trim();
  if (dataBase64.length === 0) return undefined;
  return {
    name: `clipboard-${timestamp(now)}.png`,
    mediaType: "image/png",
    dataBase64,
  };
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
