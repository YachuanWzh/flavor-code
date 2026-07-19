import React, { useMemo } from "react";
import { marked, type Token, type Tokens } from "marked";

export function parseDesktopMarkdown(text: string): Token[] {
  try { return marked.lexer(text, { gfm: true, async: false }).filter((token) => token.type !== "html"); }
  catch { return [{ type: "text", raw: text, text } as Tokens.Text]; }
}

export function MarkdownContent({ text }: { text: string }): React.JSX.Element {
  const tokens = useMemo(() => parseDesktopMarkdown(text), [text]);
  return <div className="markdown-content">{tokens.map((token, index) => <BlockToken token={token} key={`${token.type}-${index}`} />)}</div>;
}

function BlockToken({ token }: { token: Token }): React.JSX.Element | null {
  if (token.type === "space") return null;
  if (token.type === "heading") {
    const heading = token as Tokens.Heading;
    const Tag = `h${Math.min(6, heading.depth)}` as keyof React.JSX.IntrinsicElements;
    return <Tag><InlineTokens tokens={heading.tokens} /></Tag>;
  }
  if (token.type === "paragraph") return <p><InlineTokens tokens={(token as Tokens.Paragraph).tokens ?? []} /></p>;
  if (token.type === "code") {
    const code = token as Tokens.Code;
    return <div className="markdown-code"><span>{code.lang?.trim() || "code"}</span><pre><code>{code.text}</code></pre></div>;
  }
  if (token.type === "blockquote") return <blockquote>{(token as Tokens.Blockquote).tokens.map((child, index) => <BlockToken token={child} key={index} />)}</blockquote>;
  if (token.type === "list") {
    const list = token as Tokens.List;
    const Tag = list.ordered ? "ol" : "ul";
    return <Tag start={list.ordered && typeof list.start === "number" ? list.start : undefined}>{list.items.map((item, index) => <li key={index}>{item.tokens.map((child, childIndex) => <BlockToken token={child} key={childIndex} />)}</li>)}</Tag>;
  }
  if (token.type === "hr") return <hr />;
  if (token.type === "table") {
    const table = token as Tokens.Table;
    return <div className="markdown-table-wrap"><table><thead><tr>{table.header.map((cell, index) => <th key={index} style={{ textAlign: cell.align ?? undefined }}><InlineTokens tokens={cell.tokens} /></th>)}</tr></thead>
      <tbody>{table.rows.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, index) => <td key={index} style={{ textAlign: table.align[index] ?? undefined }}><InlineTokens tokens={cell.tokens} /></td>)}</tr>)}</tbody></table></div>;
  }
  if ("tokens" in token && Array.isArray(token.tokens)) return <p><InlineTokens tokens={token.tokens} /></p>;
  return "text" in token && typeof token.text === "string" ? <p>{token.text}</p> : null;
}

function InlineTokens({ tokens }: { tokens: Token[] }): React.JSX.Element {
  return <>{tokens.map((token, index) => <InlineToken token={token} key={index} />)}</>;
}

function InlineToken({ token }: { token: Token }): React.JSX.Element | string | null {
  if (token.type === "text") {
    const text = token as Tokens.Text;
    return text.tokens?.length ? <InlineTokens tokens={text.tokens} /> : text.text;
  }
  if (token.type === "strong") return <strong><InlineTokens tokens={(token as Tokens.Strong).tokens} /></strong>;
  if (token.type === "em") return <em><InlineTokens tokens={(token as Tokens.Em).tokens} /></em>;
  if (token.type === "del") return <del><InlineTokens tokens={(token as Tokens.Del).tokens} /></del>;
  if (token.type === "codespan") return <code>{(token as Tokens.Codespan).text}</code>;
  if (token.type === "br") return <br />;
  if (token.type === "escape") return (token as Tokens.Escape).text;
  if (token.type === "link") {
    const link = token as Tokens.Link;
    return <a href={link.href} target="_blank" rel="noreferrer"><InlineTokens tokens={link.tokens} /></a>;
  }
  if (token.type === "image") return <span className="markdown-image-label">[图片：{(token as Tokens.Image).text}]</span>;
  if (token.type === "html") return null;
  return "text" in token && typeof token.text === "string" ? token.text : null;
}

