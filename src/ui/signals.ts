export interface InterruptibleSession { interrupt(): "cancelled" | "exit" }

export interface InterruptHandlerOptions {
  /**
   * Hard exit hook, e.g. `() => process.exit(1)`. Invoked when Ctrl+C arrives
   * while a graceful shutdown triggered by an earlier Ctrl+C is still in
   * flight, so a stuck cleanup can never make Ctrl+C unresponsive.
   */
  forceExit: () => void;
}

/**
 * Build the Ctrl+C handler. The first press interrupts the active run (or
 * starts graceful shutdown when idle). While the graceful shutdown is in
 * flight, any further press calls `forceExit` instead of waiting — a hung
 * disposal must not swallow subsequent interrupts.
 */
export function createSessionInterruptHandler(
  getSession: () => InterruptibleSession | undefined,
  shutdown: () => void | Promise<void>,
  options: InterruptHandlerOptions,
): () => void {
  let shuttingDown = false;
  return () => {
    if (shuttingDown) {
      options.forceExit();
      return;
    }
    if (getSession()?.interrupt() === "cancelled") return;
    shuttingDown = true;
    void shutdown();
  };
}

export function installSigintHandler(
  source: { on(event: "SIGINT", handler: () => void): unknown; off(event: "SIGINT", handler: () => void): unknown },
  handler: () => void,
): () => void {
  source.on("SIGINT", handler);
  return () => { source.off("SIGINT", handler); };
}
