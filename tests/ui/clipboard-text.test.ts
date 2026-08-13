import { describe, expect, it, vi } from "vitest";

import { copyNative } from "../../src/claude-ink/termio/osc.js";

describe("CLI text clipboard", () => {
  it("writes Windows clipboard text through a UTF-8 to Unicode adapter", () => {
    const run = vi.fn(async (
      _file: string,
      _args: string[],
      _options?: { timeout?: number; useCwd?: boolean; input?: string },
    ) => ({ stdout: "", stderr: "", code: 0 }));
    const text = "看下 1.2.8 版本的新功能 🙂";

    copyNative(text, { platform: "win32", run });

    expect(run).toHaveBeenCalledOnce();
    expect(run).toHaveBeenCalledWith(
      "powershell.exe",
      expect.arrayContaining(["-NoProfile", "-NonInteractive", "-STA", "-Command"]),
      expect.objectContaining({ input: text, useCwd: false, timeout: 2000 }),
    );
    const script = run.mock.calls[0]?.[1].at(-1);
    expect(script).toContain("[Console]::OpenStandardInput()");
    expect(script).toContain("[System.Text.Encoding]::UTF8.GetString");
    expect(script).toContain("[System.Windows.Forms.Clipboard]::SetText");
  });
});
