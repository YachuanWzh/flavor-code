export function logError(error: unknown): void {
  if (process.env.DEBUG) process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
}
