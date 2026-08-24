export interface TimeoutOutcome<T> {
  /** True when the deadline passed before the promise settled. */
  timedOut: boolean;
  /** The promise value; undefined when timed out (or when the value itself is undefined). */
  value: T | undefined;
}

/**
 * Race a promise against a deadline. Settles like the promise when it finishes
 * in time; when the deadline passes first it resolves with `{ timedOut: true }`.
 * The timer is always cleared so it never keeps the event loop alive on its own.
 * The underlying promise is NOT cancelled — it keeps running in the background —
 * so only use this for work you are willing to abandon (e.g. shutdown cleanup).
 */
export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<TimeoutOutcome<T>> {
  return new Promise<TimeoutOutcome<T>>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({ timedOut: true, value: undefined });
    }, ms);
    timer.unref?.();
    promise.then(
      (value) => { if (!settled) { settled = true; clearTimeout(timer); resolve({ timedOut: false, value }); } },
      (error: unknown) => { if (!settled) { settled = true; clearTimeout(timer); reject(error); } },
    );
  });
}

/**
 * Race a promise against an AbortSignal. If the signal fires before the
 * promise settles the returned promise rejects with the signal's reason.
 */
export function awaitWithSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => { signal.removeEventListener("abort", onAbort); resolve(value); },
      (error: unknown) => { signal.removeEventListener("abort", onAbort); reject(error); },
    );
  });
}
