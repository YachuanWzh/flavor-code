import { resolve } from "node:path";
import { PassThrough } from "node:stream";
import { pathToFileURL } from "node:url";
import React from "react";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("../../src/claude-ink/supports-hyperlinks.js", () => ({ supportsHyperlinks: () => true }));

import Ink from "../../src/claude-ink/ink.js";
import { cellAt } from "../../src/claude-ink/screen.js";
import { AssistantText } from "../../src/ui/assistant-text.js";
import { FileLinkWorkspaceContext } from "../../src/ui/markdown.js";

type TestStream = NodeJS.WriteStream & { columns: number; rows: number; isTTY: boolean };
const mounted: Ink[] = [];

afterEach(() => {
  while (mounted.length > 0) mounted.pop()?.unmount();
});

function stream(): TestStream {
  const output = new PassThrough() as unknown as TestStream;
  output.columns = 24;
  output.rows = 16;
  output.isTTY = false;
  return output;
}

function linkedRows(markdown: string, workspace: string, expectedUrl: string): number[] {
  const ink = new Ink({
    stdout: stream(),
    stderr: stream(),
    stdin: new PassThrough() as unknown as NodeJS.ReadStream,
    patchConsole: false,
    exitOnCtrlC: false,
  });
  mounted.push(ink);
  ink.render(<FileLinkWorkspaceContext.Provider value={workspace}><AssistantText text={markdown} /></FileLinkWorkspaceContext.Provider>);
  const screen = (ink as unknown as { frontFrame: { screen: { width: number; height: number } } }).frontFrame.screen;
  const rows: number[] = [];
  for (let y = 0; y < screen.height; y++) {
    let linked = false;
    for (let x = 0; x < screen.width; x++) {
      const cell = cellAt(screen as Parameters<typeof cellAt>[0], x, y);
      if (cell?.hyperlink === expectedUrl) linked = true;
    }
    if (linked) rows.push(y);
  }
  return rows;
}

it.each([
  "markdown link",
  "inline code",
  "plain path",
  "bold path",
] as const)("keeps a wrapped %s clickable on every row", (kind) => {
  const workspace = resolve("project");
  const relative = "src/components/a-very-long-component-name.tsx";
  const url = pathToFileURL(resolve(workspace, relative)).href;
  const markdown = kind === "markdown link" ? `[${relative}](${relative})`
    : kind === "inline code" ? `\`${relative}\``
      : kind === "bold path" ? `**${relative}**` : relative;

  expect(linkedRows(markdown, workspace, url).length).toBeGreaterThan(1);
});

it("preserves a source line in the link target", () => {
  const workspace = resolve("project");
  const relative = "src/components/a-very-long-component-name.tsx:42";
  const url = `${pathToFileURL(resolve(workspace, relative.slice(0, -3))).href}#L42`;
  expect(linkedRows(`\`${relative}\``, workspace, url).length).toBeGreaterThan(1);
});

it("encodes spaces in a long absolute path without losing its link after wrapping", () => {
  const workspace = resolve("project");
  const absolute = resolve(workspace, "folder with spaces", "a-very-long-filename.ts");
  expect(linkedRows(`\`${absolute}\``, workspace, pathToFileURL(absolute).href).length).toBeGreaterThan(1);
});
