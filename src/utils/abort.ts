/** Wait without retaining an abort listener after the operation settles.
 * The operation must still receive the signal when it supports cancellation.
 */
export function waitWithSignal<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) return operation;
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

export interface ScopedAbortSignal {
  readonly signal: AbortSignal;
  dispose(): void;
}

/**
 * Give one provider request its own short-lived signal while preserving
 * cancellation from the enclosing turn.
 *
 * Some HTTP SDKs attach a once-only listener to the caller's signal and do
 * not remove it after a successful request. Reusing a turn signal for
 * hundreds of agent iterations then retains every request controller until
 * the entire turn ends. Disposing this scope unlinks the turn and aborts the
 * derived signal so SDK listeners and any unfinished response body release
 * their references immediately.
 */
export function createScopedAbortSignal(parent?: AbortSignal): ScopedAbortSignal {
  const controller = new AbortController();
  let disposed = false;
  const abort = (): void => {
    if (!controller.signal.aborted) controller.abort(parent?.reason);
  };
  if (parent?.aborted) abort();
  else parent?.addEventListener("abort", abort, { once: true });
  return {
    signal: controller.signal,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      parent?.removeEventListener("abort", abort);
      abort();
    },
  };
}
