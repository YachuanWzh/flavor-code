/** Extract a human-readable message from any error value. */
export function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
