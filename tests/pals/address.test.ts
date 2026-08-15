import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { palSocketAddress } from "../../src/pals/address.js";

function opaqueScope(scope: string): string {
  return `u-${createHash("sha256").update(scope, "utf8").digest("hex").slice(0, 16)}`;
}

describe("palSocketAddress", () => {
  it("uses an opaque per-user Windows named pipe", () => {
    const userScope = "DOMAIN\\alice/example";
    const address = palSocketAddress({ platform: "win32", userScope, runtimeDir: "ignored" });

    expect(address).toBe(`\\\\.\\pipe\\flavor-code-pals-${opaqueScope(userScope)}-v1`);
    expect(address).not.toContain("alice");
    expect(address).not.toContain("DOMAIN");
  });

  it("uses a runtime-directory Unix domain socket on macOS and Linux", () => {
    expect(palSocketAddress({ platform: "darwin", userScope: "alice", runtimeDir: "/tmp/flavor-alice" }))
      .toBe("/tmp/flavor-alice/pals-v1.sock");
    expect(palSocketAddress({ platform: "linux", userScope: "alice", runtimeDir: "/run/user/1000" }))
      .toBe("/run/user/1000/pals-v1.sock");
  });

  it("is deterministic and rejects empty runtime directories for Unix sockets", () => {
    const options = { platform: "win32" as const, userScope: "alice", runtimeDir: "ignored" };
    expect(palSocketAddress(options)).toBe(palSocketAddress(options));
    expect(() => palSocketAddress({ platform: "darwin", userScope: "alice", runtimeDir: "" }))
      .toThrow(/runtime directory/i);
  });
});
