import React from "react";
import { Box, Text } from "ink";

/**
 * Render the assistant's response as plain text, with light styling for
 * fenced code blocks. Mirrors Claude Code's interactive output: no
 * markdown parsing (so headings/lists/tables are shown verbatim), and the
 * only departure from raw text is a subtle background for ```…``` blocks
 * so multi-line snippets remain readable in the terminal.
 *
 * Why this exists: a previous build parsed each assistant line through
 * `marked` once streaming stopped, which produced a layout-jump every
 * time text and tokenized views disagreed by even one row. Skipping the
 * parser entirely removes the jitter and matches Claude Code's visible
 * output, while still letting the model use markdown in its raw form.
 */
export interface AssistantTextProps { text: string }

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
  if (buffer.length > 0) {
    const body = buffer.join("\n");
    segments.push({ kind: "text", body });
  }
  return segments;
}

function AssistantTextInner({ text }: AssistantTextProps): React.JSX.Element {
  const segments = React.useMemo(() => splitCodeBlocks(text), [text]);
  if (segments.length === 0) return <Text>{text}</Text>;
  return (
    <Box flexDirection="column">
      {segments.map((segment, index) => {
        if (segment.kind === "text") return <Text key={index}>{segment.body}</Text>;
        return (
          <Box key={index} flexDirection="column" marginY={0} borderStyle="single" borderColor="gray" paddingX={1}>
            {segment.lang && segment.lang.length > 0
              ? <Text dimColor>{segment.lang}</Text>
              : null}
            <Text>{segment.body}</Text>
          </Box>
        );
      })}
    </Box>
  );
}

export const AssistantText = React.memo(AssistantTextInner);
