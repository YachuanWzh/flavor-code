/** Parse a string as JSON, returning the raw string if parsing fails. */
export function parseJson(input: string): unknown {
  try {
    return JSON.parse(input) as unknown;
  } catch (error) {
    const preview = input.length > 200 ? `${input.slice(0, 200)}...` : input;
    const reason = error instanceof SyntaxError ? error.message : String(error);
    console.error(`[parseJson] JSON parse failed: ${reason}\n  input preview: ${preview}`);
    return input;
  }
}
