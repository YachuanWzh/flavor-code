import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { loadOrCreatePalAuthToken, PAL_AUTH_TOKEN_BYTES } from "../../src/pals/auth.js";

describe("pals local authentication token store", () => {
  it("atomically creates and reuses one strict 32-byte token", async () => {
    const home = await mkdtemp(join(tmpdir(), "flavor-pals-auth-"));
    const tokens = await Promise.all(Array.from({ length: 8 }, () => loadOrCreatePalAuthToken({ home })));
    expect(new Set(tokens).size).toBe(1);
    expect(tokens[0]).toMatch(/^[a-f0-9]{64}$/);
    expect(Buffer.from(tokens[0]!, "hex")).toHaveLength(PAL_AUTH_TOKEN_BYTES);
    expect((await readFile(join(home, ".flavor-code", "pals", "auth-token"), "utf8")).trim()).toBe(tokens[0]);
  });

  it.runIf(process.platform !== "win32")("uses user-only directory and file modes", async () => {
    const home = await mkdtemp(join(tmpdir(), "flavor-pals-auth-mode-"));
    await loadOrCreatePalAuthToken({ home });
    expect((await stat(join(home, ".flavor-code", "pals"))).mode & 0o777).toBe(0o700);
    expect((await stat(join(home, ".flavor-code", "pals", "auth-token"))).mode & 0o777).toBe(0o600);
  });
});
