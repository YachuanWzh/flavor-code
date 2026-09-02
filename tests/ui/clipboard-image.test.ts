import { describe, expect, it, vi } from "vitest";

import {
  readClipboardImage,
  readMacClipboardImage,
  readWindowsClipboardImage,
  shouldReadClipboardImage,
} from "../../src/ui/clipboard-image.js";

const pngBase64 = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]).toString("base64");

class JxaExit extends Error {
  constructor(readonly code: number) {
    super(`JXA exited with code ${code}`);
  }
}

function executeMacClipboardScript(
  script: string,
  values: { png?: unknown; tiff?: unknown; converted?: unknown },
): { exitCode: number; stdout: string[] } {
  const stdout: string[] = [];
  const pasteboard = {
    dataForType(type: string) {
      return type === "public.png" ? values.png : values.tiff;
    },
  };
  const dollar = Object.assign(
    (_value: unknown) => ({}),
    {
      NSPasteboard: { generalPasteboard: pasteboard },
      NSPasteboardTypePNG: "public.png",
      NSPasteboardTypeTIFF: "public.tiff",
      NSBitmapImageFileTypePNG: "png",
      NSBitmapImageRep: {
        imageRepWithData(_data: unknown) {
          return {
            representationUsingTypeProperties(_type: unknown, _properties: unknown) {
              return values.converted;
            },
          };
        },
      },
      exit(code: number) {
        throw new JxaExit(code);
      },
    },
  );
  const ObjC = {
    import(_framework: string) {},
    unwrap(value: unknown) { return value; },
  };
  const console = { log(value: unknown) { stdout.push(String(value)); } };

  try {
    Function("ObjC", "$", "console", script)(ObjC, dollar, console);
    return { exitCode: 0, stdout };
  } catch (error) {
    if (error instanceof JxaExit) return { exitCode: error.code, stdout };
    throw error;
  }
}

async function captureMacClipboardScript(): Promise<string> {
  const run = vi.fn(async (
    _file: string,
    _args: string[],
    _options?: { timeout?: number; useCwd?: boolean },
  ) => ({ stdout: "", stderr: "", code: 3 }));
  await readMacClipboardImage({ platform: "darwin", run });
  return run.mock.calls[0]?.[1].at(-1) ?? "";
}

describe("CLI clipboard image detection", () => {
  it("handles raw Ctrl+V and empty bracketed paste without hijacking text paste", () => {
    expect(shouldReadClipboardImage("v", { ctrl: true }, false)).toBe(true);
    expect(shouldReadClipboardImage("v", { ctrl: false, meta: true }, false)).toBe(true);
    expect(shouldReadClipboardImage("", { ctrl: false }, true)).toBe(true);
    expect(shouldReadClipboardImage("pasted text", { ctrl: false }, true)).toBe(false);
    expect(shouldReadClipboardImage("v", { ctrl: false }, false)).toBe(false);
  });

  it("reads a Windows bitmap as PNG through an STA PowerShell process", async () => {
    const run = vi.fn(async (
      _file: string,
      _args: string[],
      _options?: { timeout?: number; useCwd?: boolean },
    ) => ({ stdout: `${pngBase64}\r\n`, stderr: "", code: 0 }));

    await expect(readWindowsClipboardImage({
      platform: "win32",
      run,
      now: () => new Date("2026-07-30T08:00:00.000Z"),
    })).resolves.toEqual({
      name: "clipboard-20260730-080000.png",
      mediaType: "image/png",
      dataBase64: pngBase64,
    });

    expect(run).toHaveBeenCalledWith(
      "powershell.exe",
      expect.arrayContaining(["-NoProfile", "-NonInteractive", "-STA", "-Command"]),
      expect.objectContaining({ timeout: 10_000, useCwd: false }),
    );
    expect(run.mock.calls[0]?.[1].at(-1)).toContain("[Windows.Forms.Clipboard]::GetImage()");
  });

  it("reads a macOS image as PNG through AppKit JavaScript for Automation", async () => {
    const run = vi.fn(async (
      _file: string,
      _args: string[],
      _options?: { timeout?: number; useCwd?: boolean },
    ) => ({ stdout: `${pngBase64}\n`, stderr: "", code: 0 }));

    await expect(readMacClipboardImage({
      platform: "darwin",
      run,
      now: () => new Date("2026-07-30T08:00:00.000Z"),
    })).resolves.toEqual({
      name: "clipboard-20260730-080000.png",
      mediaType: "image/png",
      dataBase64: pngBase64,
    });

    expect(run).toHaveBeenCalledWith(
      "osascript",
      ["-l", "JavaScript", "-e", expect.any(String)],
      expect.objectContaining({ timeout: 10_000, useCwd: false }),
    );
    const script = run.mock.calls[0]?.[1].at(-1) ?? "";
    expect(script).toContain("$.NSPasteboard.generalPasteboard");
    expect(script).toContain("$.NSPasteboardTypePNG");
    expect(script).toContain("$.NSPasteboardTypeTIFF");
    // Regression: JXA bridges ObjC nil as a truthy proxy on some macOS
    // versions, so the script must probe bridge methods before calling them
    // and fail soft to exit(3) instead of leaking a TypeError.
    expect(script).toContain("isBridgeMethod");
    expect(script).toMatch(/catch \([A-Za-z$_]+\)/);
    const exitCount = script.match(/\$\.exit\(3\)/g)?.length ?? 0;
    expect(exitCount).toBeGreaterThanOrEqual(2);
  });

  it("executes the macOS JXA PNG path and tolerates a truthy ObjC nil proxy", async () => {
    const script = await captureMacClipboardScript();
    const png = { base64EncodedStringWithOptions: () => pngBase64 };

    expect(executeMacClipboardScript(script, { png })).toEqual({
      exitCode: 0,
      stdout: [pngBase64],
    });
    expect(executeMacClipboardScript(script, { png: {}, tiff: {} })).toEqual({
      exitCode: 3,
      stdout: [],
    });
  });

  it("executes the macOS TIFF-only conversion path when NSData.length is a property", async () => {
    const script = await captureMacClipboardScript();
    const tiff = {
      length: 128,
      base64EncodedStringWithOptions: () => "unused-tiff-base64",
    };
    const converted = { base64EncodedStringWithOptions: () => pngBase64 };

    expect(executeMacClipboardScript(script, { png: {}, tiff, converted })).toEqual({
      exitCode: 0,
      stdout: [pngBase64],
    });
  });

  it("fails soft when any macOS bridge operation throws", async () => {
    const script = await captureMacClipboardScript();
    const png = {
      base64EncodedStringWithOptions() {
        throw new TypeError("simulated Objective-C bridge failure");
      },
    };

    expect(executeMacClipboardScript(script, { png })).toEqual({
      exitCode: 3,
      stdout: [],
    });
  });

  it("returns undefined when either native clipboard has no image", async () => {
    await expect(readWindowsClipboardImage({
      platform: "win32",
      run: async () => ({ stdout: "", stderr: "", code: 3 }),
    })).resolves.toBeUndefined();
    await expect(readMacClipboardImage({
      platform: "darwin",
      run: async () => ({ stdout: "", stderr: "", code: 3 }),
    })).resolves.toBeUndefined();
  });

  it("dispatches by platform and rejects systems without a native adapter", async () => {
    await expect(readClipboardImage({
      platform: "darwin",
      run: async () => ({ stdout: pngBase64, stderr: "", code: 0 }),
    })).resolves.toMatchObject({ mediaType: "image/png", dataBase64: pngBase64 });
    await expect(readClipboardImage({
      platform: "linux",
      run: async () => ({ stdout: "", stderr: "", code: 0 }),
    })).rejects.toThrow(/Windows.*macOS/i);
  });
});
