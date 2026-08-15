import { describe, expect, it, vi } from "vitest";

import { createProgram, isLocalPalBrokerAddress } from "../../src/cli.js";

const INSTANCE_ID = "11111111-1111-4111-8111-111111111111";

describe("interactive pals CLI entry", () => {
  it("accepts a bounded pal name and creates one stable instance id for App", async () => {
    const runInteractive = vi.fn(async () => undefined);
    const randomUUID = vi.fn(() => INSTANCE_ID);
    const program = createProgram({ isTTY: () => true, randomUUID, runInteractive });

    await program.parseAsync(["node", "flavor", "--pal-name", "  api-team  "]);

    expect(randomUUID).toHaveBeenCalledTimes(1);
    expect(runInteractive).toHaveBeenCalledWith(expect.objectContaining({
      instanceId: INSTANCE_ID,
      palAlias: "api-team",
    }));
  });

  it.each(["   ", "x".repeat(65)])("rejects an invalid pal name %#", async (alias) => {
    const runInteractive = vi.fn(async () => undefined);
    const program = createProgram({ isTTY: () => true, randomUUID: () => INSTANCE_ID, runInteractive });

    await expect(program.parseAsync(["node", "flavor", "--pal-name", alias]))
      .rejects.toThrow("Pal name must be between 1 and 64 characters");
    expect(runInteractive).not.toHaveBeenCalled();
  });

  it("runs the hidden broker entry, awaits closure, and bypasses interactive startup", async () => {
    let closeBroker!: () => void;
    const closed = new Promise<void>((resolve) => { closeBroker = resolve; });
    const runBroker = vi.fn(async () => ({ closed }));
    const isTTY = vi.fn(() => { throw new Error("TTY must not be inspected"); });
    const runInteractive = vi.fn(async () => undefined);
    const randomUUID = vi.fn(() => INSTANCE_ID);
    const program = createProgram({ isTTY, randomUUID, runBroker: runBroker as never, runInteractive });

    const parsing = program.parseAsync([
      "node", "flavor", "--pals-broker", "\\\\.\\pipe\\flavor-code-pals-u-0123456789abcdef-v1",
    ]);
    await vi.waitFor(() => expect(runBroker).toHaveBeenCalledTimes(1));
    expect(runInteractive).not.toHaveBeenCalled();
    expect(isTTY).not.toHaveBeenCalled();
    expect(randomUUID).not.toHaveBeenCalled();
    closeBroker();
    await parsing;
  });

  it.each([
    "127.0.0.1:4321",
    "tcp://localhost:4321",
    "relative/pals-v1.sock",
    "\\\\remote-host\\pipe\\flavor-code-pals-u-0123456789abcdef-v1",
    "\\\\.\\pipe\\other-v1",
  ])("rejects a non-local or malformed broker address: %s", async (address) => {
    const runBroker = vi.fn();
    const program = createProgram({ runBroker: runBroker as never });

    await expect(program.parseAsync(["node", "flavor", "--pals-broker", address]))
      .rejects.toThrow("Invalid local pals broker address");
    expect(runBroker).not.toHaveBeenCalled();
  });

  it("recognizes only platform-native local IPC address forms", () => {
    expect(isLocalPalBrokerAddress("\\\\.\\pipe\\flavor-code-pals-u-0123456789abcdef-v1", "win32")).toBe(true);
    expect(isLocalPalBrokerAddress("/tmp/flavor-user/pals-v1.sock", "darwin")).toBe(true);
    expect(isLocalPalBrokerAddress("/run/user/1000/pals-v1.sock", "linux")).toBe(true);
    expect(isLocalPalBrokerAddress("/tmp/flavor-user/pals-v1.sock", "win32")).toBe(false);
    expect(isLocalPalBrokerAddress("\\\\.\\pipe\\flavor-code-pals-u-0123456789abcdef-v1", "darwin")).toBe(false);
  });
});
