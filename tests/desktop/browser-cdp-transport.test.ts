import { describe, expect, it, vi } from "vitest";

import { CdpTransport, CDP_MAX_PENDING_COMMANDS } from "../../src/desktop/browser/cdp-transport.js";
import { BrowserError } from "../../src/desktop/browser/types.js";

class FakeDebugger {
  attached = false;
  detachListeners: ((sender: unknown, details: { reason: string }) => void)[] = [];
  messageListeners: ((sender: unknown, message: unknown) => void)[] = [];
  commands: { method: string; params: Record<string, unknown> | undefined; sessionId: string | undefined }[] = [];
  responders: ((method: string) => Promise<unknown> | undefined) | undefined;
  hang = false;

  attach(): void {
    this.attached = true;
  }
  detach(): void {
    this.attached = false;
  }
  isAttached(): boolean {
    return this.attached;
  }
  on(event: string, listener: (...args: unknown[]) => void): void {
    if (event === "detach") this.detachListeners.push(listener as never);
    else this.messageListeners.push(listener as never);
  }
  removeListener(event: string, listener: (...args: unknown[]) => void): void {
    const list = event === "detach" ? this.detachListeners : this.messageListeners;
    const index = list.indexOf(listener as never);
    if (index >= 0) list.splice(index, 1);
  }
  sendCommand(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<unknown> {
    this.commands.push({ method, params, sessionId });
    if (this.hang) return new Promise(() => undefined);
    const custom = this.responders?.(method);
    return custom ?? Promise.resolve({ ok: true });
  }
  emitMessage(message: unknown): void {
    for (const listener of this.messageListeners) listener(undefined, message);
  }
  emitDetach(reason: string): void {
    this.attached = false;
    for (const listener of this.detachListeners) listener(undefined, { reason });
  }
}

function makeTransport(debugger_: FakeDebugger, timeoutMs?: number): CdpTransport {
  return new CdpTransport(debugger_ as never, timeoutMs === undefined ? {} : { timeoutMs });
}

describe("cdp transport", () => {
  it("attaches lazily and forwards commands with session ids", async () => {
    const fake = new FakeDebugger();
    const transport = makeTransport(fake);
    expect(fake.attached).toBe(false);
    const result = await transport.sendCommand("Page.enable", undefined, { sessionId: "s1" });
    expect(result).toEqual({ ok: true });
    expect(fake.attached).toBe(true);
    expect(fake.commands[0]).toEqual({ method: "Page.enable", params: undefined, sessionId: "s1" });
    transport.dispose();
  });

  it("times out hung commands as transient errors", async () => {
    vi.useFakeTimers();
    try {
      const fake = new FakeDebugger();
      fake.hang = true;
      const transport = makeTransport(fake, 100);
      const pending = transport.sendCommand("Runtime.evaluate");
      let failure: unknown;
      pending.catch((error) => {
        failure = error;
      });
      await vi.advanceTimersByTimeAsync(150);
      expect(failure).toBeInstanceOf(BrowserError);
      expect((failure as BrowserError).transient).toBe(true);
      transport.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects immediately on an already-aborted signal", async () => {
    const fake = new FakeDebugger();
    const transport = makeTransport(fake);
    const controller = new AbortController();
    controller.abort();
    await expect(transport.sendCommand("Page.navigate", {}, { signal: controller.signal })).rejects.toThrow(/aborted/);
    transport.dispose();
  });

  it("rejects every pending command when the debugger detaches, then re-attaches once lazily", async () => {
    vi.useFakeTimers();
    try {
      const fake = new FakeDebugger();
      fake.hang = true;
      const transport = makeTransport(fake, 5_000);
      const pending = transport.sendCommand("Page.captureScreenshot");
      let failure: unknown;
      pending.catch((error) => {
        failure = error;
      });
      fake.emitDetach("devtools");
      await Promise.resolve();
      expect(failure).toBeInstanceOf(BrowserError);
      expect((failure as BrowserError).code).toBe("detached");
      expect((failure as BrowserError).transient).toBe(true);
      // recovery: the next command re-attaches the debugger
      fake.hang = false;
      const recovered = await transport.sendCommand("Page.enable");
      expect(recovered).toEqual({ ok: true });
      expect(fake.attached).toBe(true);
      transport.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("delivers filtered CDP events to subscribers", () => {
    const fake = new FakeDebugger();
    const transport = makeTransport(fake);
    transport.attach();
    const seen: string[] = [];
    const unsubscribe = transport.onEvent("Page.lifecycleEvent", (message) => {
      seen.push(String((message.params as { name?: string })?.name ?? ""));
    }, "s9");
    transport.onEvent("Network.requestWillBeSent", () => {
      seen.push("should-not-fire");
    });
    fake.emitMessage({ method: "Page.lifecycleEvent", params: { name: "load" }, sessionId: "s9" });
    fake.emitMessage({ method: "Page.lifecycleEvent", params: { name: "x" }, sessionId: "other" });
    fake.emitMessage({ method: "Page.lifecycleEvent", params: { name: "y" } });
    unsubscribe();
    fake.emitMessage({ method: "Page.lifecycleEvent", params: { name: "after" }, sessionId: "s9" });
    expect(seen).toEqual(["load"]);
    transport.dispose();
  });

  it("caps in-flight commands to bound memory", async () => {
    const fake = new FakeDebugger();
    fake.hang = true;
    const transport = makeTransport(fake, 60_000);
    for (let i = 0; i < CDP_MAX_PENDING_COMMANDS; i += 1) {
      void transport.sendCommand("Runtime.evaluate").catch(() => undefined);
    }
    await expect(transport.sendCommand("Runtime.evaluate")).rejects.toThrow(/Too many pending/);
    transport.dispose();
  });

  it("disposal rejects pending commands and detaches", async () => {
    const fake = new FakeDebugger();
    fake.hang = true;
    const transport = makeTransport(fake, 60_000);
    const pending = transport.sendCommand("Page.enable");
    transport.dispose();
    await expect(pending).rejects.toThrow(/disposed/);
    await expect(transport.sendCommand("Page.enable")).rejects.toThrow(/disposed/);
    expect(fake.attached).toBe(false);
  });
});
