import React, { useMemo } from "react";
import { Box, Text, useStdout } from "ink";
import chalk from "chalk";
import { marked } from "marked";
import type { Token, Tokens } from "marked";

import { highlightCode } from "./highlight.js";
import { charWidth } from "./char-width.js";

/* ------------------------------------------------------------------ */
/*  Public component                                                   */
/* ------------------------------------------------------------------ */

export interface MarkdownViewProps { text: string }

/**
 * Render markdown text as styled Ink components, modelled on the visual
 * feel of Claude Code. Streams markdown from the moment the first chunk
 * lands; partial input that does not yet close a code block or list still
 * parses to a sensible token tree via marked.lexer and degrades cleanly.
 *
 * Pure render — no side effects, no state outside the input props. The
 * component is wrapped in `React.memo` so unchanged frozen lines skip the
 * React reconciliation cost.
 */
function MarkdownViewInner({ text }: MarkdownViewProps): React.JSX.Element {
  const tokens = useMemo(() => {
    // Pathological-size guard: skip the lexer and fall back to plain text
    // when a streaming line grows beyond this limit.
    if (text.length > 50_000) return null;
    try {
      return marked.lexer(text, { gfm: true, async: false });
    } catch {
      return null;
    }
  }, [text]);

  if (tokens === null) {
    return <Text>{text}</Text>;
  }

  return (
    <Box flexDirection="column" width="100%">
      {tokens.map((token, i) => (
        <BlockToken key={i} token={token} />
      ))}
    </Box>
  );
}

export const MarkdownView = React.memo(MarkdownViewInner);

/* ------------------------------------------------------------------ */
/*  Block-level renderer                                               */
/* ------------------------------------------------------------------ */

function BlockToken({ token }: { token: Token }): React.JSX.Element | null {
  switch (token.type) {
    case "space":
      return <Box height={1} />;
    case "heading":
      return <HeadingView token={token as Tokens.Heading} />;
    case "paragraph":
      return (
        <Text>
          <InlineTokens tokens={token.tokens ?? []} />
        </Text>
      );
    case "code":
      return <CodeBlock token={token as Tokens.Code} />;
    case "blockquote":
      return <BlockquoteView token={token as Tokens.Blockquote} />;
    case "list":
      return <ListView token={token as Tokens.List} />;
    case "hr":
      return <HrView />;
    case "table":
      return <TableView token={token as Tokens.Table} />;
    case "html":
      return <Text dimColor>[html]</Text>;
    default:
      if ("text" in token && typeof token.text === "string") {
        return <Text>{token.text}</Text>;
      }
      return null;
  }
}

/* ------------------------------------------------------------------ */
/*  Block views                                                        */
/* ------------------------------------------------------------------ */

function HeadingView({ token }: { token: Tokens.Heading }): React.JSX.Element {
  const styled = useMemo(() => {
    const inner = renderInlineText(token.tokens);
    switch (token.depth) {
      case 1: return chalk.bold.hex("#7dd3fc")(inner);
      case 2: return chalk.bold.hex("#67e8f9")(inner);
      case 3: return chalk.bold.hex("#93c5fd")(inner);
      default: return chalk.italic.hex("#93c5fd")(inner);
    }
  }, [token.depth, token.tokens]);
  return <Text>{styled}</Text>;
}

function CodeBlock({ token }: { token: Tokens.Code }): React.JSX.Element {
  const { stdout } = useStdout();
  const columns = stdout?.columns ?? 80;
  const innerWidth = Math.max(20, columns - 6); // 2 indent each side + 2 border
  const styledSource = useMemo(() => highlightCode(token.text, token.lang), [token.text, token.lang]);
  const lines = useMemo(() => styledSource.split("\n"), [styledSource]);
  const truncated = useMemo(() => lines.map((line) => truncateToWidth(line, innerWidth - 2)), [lines, innerWidth]);
  const langLabel = token.lang?.trim();
  const label = langLabel && langLabel.length > 0 ? langLabel : "code";
  const topBarWidth = Math.max(0, columns - 4 - label.length - 4);
  return (
    <Box flexDirection="column" paddingX={1}>
      <Text color="gray">{"╭─ "}<Text color="cyan">{label}</Text>{" "}{"─".repeat(topBarWidth)}{"╮"}</Text>
      <Box flexDirection="column" paddingX={1}>
        {truncated.map((line, i) => (
          <Text key={i} color="gray">{line}</Text>
        ))}
      </Box>
      <Text color="gray">{"╰"}{"─".repeat(Math.max(0, columns - 6))}{"╯"}</Text>
    </Box>
  );
}

function BlockquoteView({ token }: { token: Tokens.Blockquote }): React.JSX.Element {
  return (
    <Box flexDirection="column">
      {token.tokens.map((child, i) => {
        const inline = "tokens" in child ? (child as Tokens.Paragraph).tokens ?? [] : [];
        return (
          <Text key={i}>
            <Text color="gray">│ </Text>
            <InlineTokens tokens={inline} />
          </Text>
        );
      })}
    </Box>
  );
}

function HrView(): React.JSX.Element {
  const { stdout } = useStdout();
  const width = Math.max(8, (stdout?.columns ?? 80) - 4);
  return <Text color="gray">{"─".repeat(width)}</Text>;
}

/* ------------------------------------------------------------------ */
/*  List                                                               */
/* ------------------------------------------------------------------ */

function ListView({ token }: { token: Tokens.List }): React.JSX.Element {
  const start = typeof token.start === "number" ? token.start : 1;
  return (
    <Box flexDirection="column">
      {token.items.map((item, i) => (
        <ListItemView key={i} item={item} index={start + i} ordered={token.ordered} />
      ))}
    </Box>
  );
}

function ListItemView({
  item,
  index,
  ordered,
}: {
  item: Tokens.ListItem;
  index: number;
  ordered: boolean | undefined;
}): React.JSX.Element {
  const bullet = ordered ? `${index}.` : "-";
  // Split the item's children into the leading inline line (the bullet row)
  // and any subsequent block-level children (code, sublist, paragraph break).
  // Wrapping the whole item in a `<Box>` keeps Ink happy — block children
  // cannot legally live inside a `<Text>` parent.
  const inlineTokens: Array<Tokens.Paragraph | Tokens.Text> = [];
  const blockTokens: Token[] = [];
  let firstParagraphConsumed = false;
  for (const child of item.tokens) {
    if (child.type === "paragraph") {
      const paragraph = child as Tokens.Paragraph;
      if (!firstParagraphConsumed) {
        inlineTokens.push(paragraph);
        firstParagraphConsumed = true;
      } else {
        blockTokens.push(child);
      }
    } else if (child.type === "text") {
      inlineTokens.push(child as Tokens.Text);
    } else {
      blockTokens.push(child);
    }
  }

  return (
    <Box flexDirection="column">
      <Text>
        <Text color="cyan">{bullet} </Text>
        {inlineTokens.map((child, i) => {
          if (child.type === "paragraph") {
            return <InlineTokens key={i} tokens={(child as Tokens.Paragraph).tokens ?? []} />;
          }
          return <Text key={i}>{child.text}</Text>;
        })}
      </Text>
      {blockTokens.map((child, i) => (
        <Box key={i} marginLeft={2}>
          <BlockToken token={child} />
        </Box>
      ))}
    </Box>
  );
}

/* ------------------------------------------------------------------ */
/*  Table                                                              */
/* ------------------------------------------------------------------ */

function TableView({ token }: { token: Tokens.Table }): React.JSX.Element {
  const { stdout } = useStdout();
  const maxWidth = stdout?.columns ?? 80;
  const colCount = token.header.length;
  if (colCount === 0) return <Text dimColor>[empty table]</Text>;

  const colWidth = Math.max(8, Math.floor((maxWidth - colCount * 3) / colCount));
  const pad = (value: string, w: number, align: "left" | "right" | "center" | null): string => {
    const stripped = stripAnsi(value);
    const width = Math.max(0, w);
    if (stripped.length > width) return stripped.slice(0, width - 1) + "…";
    const diff = width - stripped.length;
    if (align === "right") return " ".repeat(diff) + stripped;
    if (align === "center") {
      const left = Math.floor(diff / 2);
      const right = diff - left;
      return " ".repeat(left) + stripped + " ".repeat(right);
    }
    return stripped + " ".repeat(diff);
  };

  const separator = token.header.map((cell) => {
    const align = cell.align;
    if (align === "left") return ":" + "─".repeat(colWidth - 2) + " ";
    if (align === "right") return " " + "─".repeat(colWidth - 2) + ":";
    if (align === "center") return ":" + "─".repeat(colWidth - 2) + ":";
    return "─".repeat(colWidth);
  });

  return (
    <Box flexDirection="column">
      <Text>
        {token.header.map((cell, i) => pad(cell.text, colWidth, cell.align ?? "left")).join(" │ ")}
      </Text>
      <Text dimColor>{separator.join(" │ ")}</Text>
      {token.rows.map((row, ri) => (
        <Text key={ri}>
          {row.map((cell, i) => pad(cell.text, colWidth, token.header[i]?.align ?? "left")).join(" │ ")}
        </Text>
      ))}
    </Box>
  );
}

/* ------------------------------------------------------------------ */
/*  Inline renderer                                                    */
/* ------------------------------------------------------------------ */

function InlineTokens({ tokens }: { tokens: Token[] }): React.JSX.Element {
  return (
    <Text>
      {tokens.map((token, i) => (
        <InlineToken key={i} token={token} />
      ))}
    </Text>
  );
}

function InlineToken({ token }: { token: Token }): React.JSX.Element | null {
  switch (token.type) {
    case "text":
      return <Text>{(token as Tokens.Text).raw ?? token.text}</Text>;
    case "strong":
      return <Text bold>{renderInlineText((token as Tokens.Strong).tokens)}</Text>;
    case "em":
      return <Text italic>{renderInlineText((token as Tokens.Em).tokens)}</Text>;
    case "del":
      return <Text strikethrough>{renderInlineText((token as Tokens.Del).tokens)}</Text>;
    case "codespan":
      return <Text color="black" backgroundColor="gray">{(token as Tokens.Codespan).text}</Text>;
    case "link": {
      const link = token as Tokens.Link;
      const inner = renderInlineText(link.tokens);
      return (
        <Text>
          {inner}
          <Text dimColor color="blue"> ({link.href})</Text>
        </Text>
      );
    }
    case "image": {
      const img = token as Tokens.Image;
      return <Text dimColor>[image: {img.text}]</Text>;
    }
    case "br":
      return <Text>{"\n"}</Text>;
    case "escape":
      return <Text>{(token as Tokens.Escape).text}</Text>;
    case "html":
      return null;
    default:
      if ("text" in token && typeof token.text === "string") {
        return <Text>{token.text}</Text>;
      }
      return null;
  }
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

const ANSI_RE = /\x1B\[[0-?]*[ -/]*[@-~]/g;
function stripAnsi(value: string): string {
  return value.replace(ANSI_RE, "");
}

function visibleWidth(value: string): number {
  // Strip ANSI then sum the display width of each code point so CJK and
  // emoji (2 columns) are counted correctly.
  let width = 0;
  for (const ch of stripAnsi(value)) {
    width += charWidth(ch.codePointAt(0) ?? 0);
  }
  return width;
}

function truncateToWidth(value: string, width: number): string {
  if (width <= 0) return "";
  const stripped = stripAnsi(value);
  if (visibleWidth(stripped) <= width) return value;
  const prefix = (value.match(/^\x1B\[[0-?]*[ -/]*[@-~]*/)?.[0]) ?? "";
  const suffix = "\x1B[0m";
  let out = "";
  let visual = 0;
  for (const ch of stripped) {
    const cw = charWidth(ch.codePointAt(0) ?? 0);
    if (visual + cw > width - 1) break; // reserve 1 col for "…"
    out += ch;
    visual += cw;
  }
  return prefix + out + "…" + suffix;
}

function renderInlineText(tokens: readonly Token[]): string {
  let out = "";
  for (const tok of tokens) {
    out += inlineTokenToString(tok);
  }
  return out;
}

function inlineTokenToString(token: Token): string {
  switch (token.type) {
    case "text":
      return (token as Tokens.Text).raw ?? token.text;
    case "strong":
      return chalk.bold(renderInlineText((token as Tokens.Strong).tokens));
    case "em":
      return chalk.italic(renderInlineText((token as Tokens.Em).tokens));
    case "del":
      return chalk.strikethrough(renderInlineText((token as Tokens.Del).tokens));
    case "codespan":
      return chalk.bgGray.black(` ${(token as Tokens.Codespan).text} `);
    case "escape":
      return (token as Tokens.Escape).text;
    case "br":
      return "\n";
    case "link": {
      const link = token as Tokens.Link;
      const inner = renderInlineText(link.tokens);
      return `${inner} ${chalk.blue.underline.dim(`(${link.href})`)}`;
    }
    default:
      if ("text" in token && typeof token.text === "string") return token.text;
      return "";
  }
}

// visibleWidth now used by truncateToWidth above.
