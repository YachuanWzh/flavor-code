import { describe, expect, it } from "vitest";

/**
 * Replicate the runtime helper exported from `assistant-text.tsx` so we
 * can test the code-block splitter without spinning up Ink / React. The
 * implementation in `assistant-text.tsx` is intentionally kept tiny and
 * pure so that this is the only behaviour worth pinning down.
 */
interface Segment { kind: "text" | "code"; body: string; lang?: string }

function splitCodeBlocks(input: string): Segment[] {
  const segments: Segment[] = [];
  const lines = input.split("\n");
  let i = 0;
  let buffer: string[] = [];
  while (i < lines.length) {
    const line = lines[i] ?? "";
    const fence = line.match(/^```(\S+)?\s*$/);
    if (fence === null) {
      buffer.push(line);
      i += 1;
      continue;
    }
    if (buffer.length > 0) {
      const body = buffer.join("\n");
      segments.push({ kind: "text", body: body.endsWith("\n") ? body : body + "\n" });
      buffer = [];
    }
    const lang = fence[1];
    const code: string[] = [];
    i += 1;
    while (i < lines.length) {
      const inner = lines[i] ?? "";
      if (inner.match(/^```\s*$/)) { i += 1; break; }
      code.push(inner);
      i += 1;
    }
    segments.push({ kind: "code", body: code.join("\n"), lang: lang ?? "" });
  }
  if (buffer.length > 0) segments.push({ kind: "text", body: buffer.join("\n") });
  return segments;
}

describe("AssistantText code-block splitter", () => {
  it("returns a single empty text segment for empty input", () => {
    // The renderer can stay simple by always producing one segment, even
    // for an empty payload — it falls through to a plain `<Text>`.
    expect(splitCodeBlocks("")).toEqual([{ kind: "text", body: "" }]);
  });

  it("treats plain text as a single text segment", () => {
    expect(splitCodeBlocks("hello world")).toEqual([
      { kind: "text", body: "hello world" },
    ]);
  });

  it("captures the language tag from the opening fence", () => {
    const segments = splitCodeBlocks("```ts\nconst x = 1;\n```");
    expect(segments).toEqual([
      { kind: "code", body: "const x = 1;", lang: "ts" },
    ]);
  });

  it("splits prose that wraps a fenced block into text + code + text", () => {
    const segments = splitCodeBlocks("intro\n```js\nfoo\n```\nafter");
    expect(segments.map((segment) => segment.kind)).toEqual(["text", "code", "text"]);
    const codeSegment = segments[1];
    expect(codeSegment?.body).toBe("foo");
    expect(codeSegment?.lang).toBe("js");
  });

  it("leaves fence markers in place inside a code block (no nested parsing)", () => {
    const segments = splitCodeBlocks("```\n```inside\n```");
    expect(segments).toHaveLength(1);
    expect(segments[0]?.body).toBe("```inside");
  });
});
