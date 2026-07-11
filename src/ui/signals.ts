export interface InterruptibleSession { interrupt(): "cancelled" | "exit" }

export function createSessionInterruptHandler(
  getSession: () => InterruptibleSession | undefined,
  shutdown: () => void | Promise<void>,
): () => void {
  return () => {
    if (getSession()?.interrupt() === "cancelled") return;
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
