/**
 * Parse a string as JSON.
 *
 * Returns the parsed value on success, or `null` when the string is not valid
 * JSON.  Unlike the previous implementation this never returns the raw string,
 * so callers can safely treat a null return as "not JSON" without risking a
 * string masquerading as a parsed object downstream.
 *
 * DeepSeek and other third-party Anthropic-compatible providers have been
 * observed returning tool-call arguments as double-encoded JSON strings
 * (e.g. `"{\"path\": ...}"`) instead of a proper JSON object.  Callers
 * should handle that at a higher level (see normalizeToolCallInput).
 */
export function parseJson(input: string): unknown {
  try {
    return JSON.parse(input) as unknown;
  } catch (error) {
    const preview = input.length > 200 ? `${input.slice(0, 200)}...` : input;
    const reason = error instanceof SyntaxError ? error.message : String(error);
    console.error(`[parseJson] JSON parse failed: ${reason}\n  input preview: ${preview}`);
    return null;
  }
}

/** Result of a safe JSON parse that never throws. */
export interface SafeJsonResult {
  ok: true;
  value: unknown;
}

export interface SafeJsonError {
  ok: false;
  error: string;
}

export type SafeJson = SafeJsonResult | SafeJsonError;

/** Parse a string as JSON, returning a discriminated union on failure. */
export function safeParseJson(input: string): SafeJson {
  try {
    return { ok: true, value: JSON.parse(input) as unknown };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof SyntaxError ? error.message : String(error),
    };
  }
}

/**
 * Normalize tool-call input that arrived from a model API stream.
 *
 * Model providers (especially third-party Anthropic-compatible ones like
 * DeepSeek) may return tool-call arguments in one of these forms:
 *
 * 1. **Object** — non-streaming / fallback paths (pass through).
 * 2. **JSON string** (`'{"path":"x","content":"y"}'`) — normal streaming.
 * 3. **Double-encoded JSON string** (`'"{\\"path\\":...}"'`) — some providers
 *    nest the JSON inside an extra string layer.
 * 4. **Empty string** — treated as `{}` for no-argument tools.
 * 5. **Malformed JSON** — rejected with the parse failure preserved.
 *
 * This function recursively unwraps nested strings until it reaches an object
 * or exhausts the unwrapping depth. Invalid input throws instead of silently
 * becoming `{}`, because that destroys the provider-side failure evidence.
 */
export function normalizeToolCallInput(
  input: unknown,
  maxDepth: number = 3,
): Record<string, unknown> {
  // Already a plain object — pass through (non-streaming / fallback paths).
  if (typeof input === "object" && input !== null && !Array.isArray(input)) {
    return input as Record<string, unknown>;
  }

  // Streaming path: the adapter accumulated input_json_delta fragments into a
  // JSON string.  The string may itself parse to another string (double
  // encoding), so we loop until we hit an object or run out of depth.
  if (typeof input === "string") {
    if (input.trim().length === 0) return {};
    let current: unknown = input;
    for (let depth = 0; depth < maxDepth; depth++) {
      if (typeof current !== "string" || current.length === 0) break;
      const parsed = safeParseJson(current);
      if (!parsed.ok) {
        throw new Error(
          `Tool-call input is not valid JSON (${current.length} characters): ${parsed.error}`,
        );
      }
      if (typeof parsed.value === "object" && parsed.value !== null && !Array.isArray(parsed.value)) {
        return parsed.value as Record<string, unknown>;
      }
      // value is a primitive (string, number, etc.) — keep unwrapping.
      current = parsed.value;
    }
    // Exhausted depth — return whatever we have if it's an object.
    if (typeof current === "object" && current !== null && !Array.isArray(current)) {
      return current as Record<string, unknown>;
    }
  }

  const kind = input === null ? "null" : Array.isArray(input) ? "array" : typeof input;
  throw new Error(`Tool-call input must decode to an object; received ${kind}`);
}
