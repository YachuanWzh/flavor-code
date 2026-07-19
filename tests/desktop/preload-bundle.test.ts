import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("desktop preload bundle", () => {
  it("imports runtime values only from the dependency-free channel module", async () => {
    const [preload, channels] = await Promise.all([
      readFile("src/desktop/preload.ts", "utf8"),
      readFile("src/desktop/channels.ts", "utf8"),
    ]);
    expect(preload).toContain('import { DESKTOP_CHANNELS } from "./channels.js"');
    expect(preload).toContain('import type { DesktopEvent, FlavorDesktopApi } from "./contracts.js"');
    expect(channels).not.toMatch(/^import /m);
    expect(channels).not.toContain("zod");
  });
});
