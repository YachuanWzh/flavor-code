import { describe, expect, it, vi } from "vitest";
import { createSessionInterruptHandler, installSigintHandler } from "../../src/ui/signals.js";

describe("createSessionInterruptHandler", () => {
  it("first Ctrl+C cancels the active run without shutting down", () => {
    const interrupt = vi.fn(() => "cancelled" as const);
    const shutdown = vi.fn();
    const handler = createSessionInterruptHandler(() => ({ interrupt }), shutdown, { forceExit: vi.fn() });
    handler();
    expect(interrupt).toHaveBeenCalledOnce();
    expect(shutdown).not.toHaveBeenCalled();
  });

  it("starts graceful shutdown when Ctrl+C arrives while idle", () => {
    const interrupt = vi.fn(() => "exit" as const);
    const shutdown = vi.fn();
    const handler = createSessionInterruptHandler(() => ({ interrupt }), shutdown, { forceExit: vi.fn() });
    handler();
    expect(interrupt).toHaveBeenCalledOnce();
    expect(shutdown).toHaveBeenCalledOnce();
  });

  it("force-exits when Ctrl+C arrives while a graceful shutdown is still in flight", () => {
    const interrupt = vi.fn(() => "exit" as const);
    let resolveShutdown: (() => void) | undefined;
    const shutdown = vi.fn(() => new Promise<void>((resolve) => { resolveShutdown = resolve; }));
    const forceExit = vi.fn();
    const handler = createSessionInterruptHandler(() => ({ interrupt }), shutdown, { forceExit });
    handler();
    expect(shutdown).toHaveBeenCalledOnce();
    // The shutdown is hung; a second Ctrl+C must force-exit instead of waiting.
    handler();
    handler();
    expect(forceExit).toHaveBeenCalledTimes(2);
    expect(interrupt).toHaveBeenCalledOnce();
    resolveShutdown?.();
  });

  it("starts shutdown when no session exists yet", () => {
    const shutdown = vi.fn();
    const handler = createSessionInterruptHandler(() => undefined, shutdown, { forceExit: vi.fn() });
    handler();
    expect(shutdown).toHaveBeenCalledOnce();
  });
});

describe("installSigintHandler", () => {
  it("registers the handler and removes it on cleanup", () => {
    const on = vi.fn();
    const off = vi.fn();
    const handler = () => undefined;
    const uninstall = installSigintHandler({ on, off }, handler);
    expect(on).toHaveBeenCalledWith("SIGINT", handler);
    uninstall();
    expect(off).toHaveBeenCalledWith("SIGINT", handler);
  });
});
