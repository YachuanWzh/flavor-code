import { describe, expect, it } from "vitest";

import { parseDesktopMarkdown } from "../../src/desktop/renderer/markdown.js";

describe("desktop markdown", () => {
  it("parses headings, tables and fenced code without returning raw HTML blocks", () => {
    const tokens = parseDesktopMarkdown("## Title\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n```ts\nconst x = 1\n```\n<script>alert(1)</script>");
    expect(tokens.map((token) => token.type)).toEqual(["heading", "table", "code"]);
  });
});
