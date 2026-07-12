/** Parse a string as JSON, returning the raw string if parsing fails. */
export function parseJson(input: string): unknown {
  try {
    return JSON.parse(input) as unknown;
  } catch {
    return input;
  }
}
