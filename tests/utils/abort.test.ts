import { getEventListeners } from "node:events";
import { describe, expect, it } from "vitest";

import { createScopedAbortSignal } from "../../src/utils/abort.js";

describe("createScopedAbortSignal", () => {
  it("propagates cancellation and unlinks from the parent", () => {
    const parent = new AbortController();
    const scoped = createScopedAbortSignal(parent.signal);
    expect(getEventListeners(parent.signal, "abort")).toHaveLength(1);

    parent.abort(new Error("stop"));

    expect(scoped.signal.aborted).toBe(true);
    expect(scoped.signal.reason).toBe(parent.signal.reason);
    scoped.dispose();
    expect(getEventListeners(parent.signal, "abort")).toHaveLength(0);
  });

  it("aborts and detaches a completed request scope", () => {
    const parent = new AbortController();
    const scoped = createScopedAbortSignal(parent.signal);
    scoped.signal.addEventListener("abort", () => undefined, { once: true });

    scoped.dispose();

    expect(scoped.signal.aborted).toBe(true);
    expect(getEventListeners(scoped.signal, "abort")).toHaveLength(0);
    expect(getEventListeners(parent.signal, "abort")).toHaveLength(0);
  });
});
