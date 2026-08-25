import type { SessionTreeNode } from "../../session/tree.js";
import type { DesktopAstNode, DesktopAstRelations } from "../astgraph-service.js";

export interface ReviewHunk {
  id: string;
  header: string;
  start: number;
  end: number;
}

export interface ReviewFile {
  path: string;
  lines: readonly string[];
  hunks: readonly ReviewHunk[];
  additions: number;
  deletions: number;
}

export function parseReviewDiff(diff: string): ReviewFile[] {
  const files: ReviewFile[] = [];
  let draft: { path: string; lines: string[]; hunks: ReviewHunk[]; additions: number; deletions: number } | undefined;
  const finish = () => {
    if (draft === undefined) return;
    const end = draft.lines.length;
    const hunks = draft.hunks.map((hunk, index) => ({ ...hunk, end: draft!.hunks[index + 1]?.start ?? end }));
    files.push({ ...draft, hunks });
  };
  for (const line of diff.split(/\r?\n/)) {
    const boundary = /^diff --(?:git|flavor) a\/(.+?) b\/(.+)$/.exec(line);
    if (boundary !== null) {
      finish();
      draft = { path: boundary[2]!, lines: [line], hunks: [], additions: 0, deletions: 0 };
      continue;
    }
    if (draft === undefined) continue;
    const index = draft.lines.length;
    draft.lines.push(line);
    if (line.startsWith("@@")) draft.hunks.push({ id: `${draft.path}:${draft.hunks.length + 1}`, header: line, start: index, end: index + 1 });
    else if (line.startsWith("+") && !line.startsWith("+++")) draft.additions += 1;
    else if (line.startsWith("-") && !line.startsWith("---")) draft.deletions += 1;
  }
  finish();
  return files;
}

export interface AstGraphNode extends DesktopAstNode {
  role: "origin" | "caller" | "callee" | "impact";
  x: number;
  y: number;
  hop?: number;
}
export interface AstGraphEdge { from: string; to: string; kind: "caller" | "callee" | "impact"; hop?: number }
export interface AstGraphModel { nodes: readonly AstGraphNode[]; edges: readonly AstGraphEdge[] }

export function buildAstGraphModel(origin: DesktopAstNode, relations: DesktopAstRelations): AstGraphModel {
  const nodes = new Map<string, AstGraphNode>();
  const edges: AstGraphEdge[] = [];
  nodes.set(origin.id, { ...origin, role: "origin", x: 50, y: 50 });
  const lane = (items: readonly DesktopAstNode[], role: "caller" | "callee", x: number) => {
    items.slice(0, 8).forEach((node, index, visible) => {
      nodes.set(node.id, { ...node, role, x, y: ((index + 1) * 100) / (visible.length + 1) });
      edges.push(role === "caller" ? { from: node.id, to: origin.id, kind: role } : { from: origin.id, to: node.id, kind: role });
    });
  };
  lane(relations.callers, "caller", 14);
  lane(relations.callees, "callee", 86);
  const impact = relations.impact.filter((node) => !nodes.has(node.id)).slice(0, 12);
  impact.forEach((node, index) => {
    const upper = index % 2 === 0;
    const column = Math.floor(index / 2);
    const x = 25 + (column % 6) * 10;
    const y = upper ? 13 : 87;
    nodes.set(node.id, { ...node, role: "impact", x, y, hop: node.hop });
    edges.push({ from: origin.id, to: node.id, kind: "impact", hop: node.hop });
  });
  return { nodes: [...nodes.values()], edges };
}

export function sessionTreeRows<T extends Pick<SessionTreeNode, "id" | "parentId">>(nodes: readonly T[]): Array<{ node: T; depth: number }> {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  return nodes.map((node) => {
    let depth = 0;
    let parent = node.parentId;
    const seen = new Set<string>([node.id]);
    while (parent !== null && depth < 12 && !seen.has(parent)) {
      seen.add(parent);
      const ancestor = byId.get(parent);
      if (ancestor === undefined) break;
      depth += 1;
      parent = ancestor.parentId;
    }
    return { node, depth };
  });
}

export function terminalGridSize(width: number, height: number): { columns: number; rows: number } {
  return {
    columns: Math.min(500, Math.max(20, Math.floor((width - 26) / 8))),
    rows: Math.min(300, Math.max(5, Math.floor((height - 24) / 18))),
  };
}

export function terminalShellName(shell: string): string {
  return shell.replaceAll("\\", "/").split("/").filter(Boolean).at(-1) ?? shell;
}

export function reconcileTerminalSelection(
  current: string | undefined,
  terminals: readonly { id: string; state: "running" | "exited" | "closed" }[],
): string | undefined {
  const visible = terminals.filter((terminal) => terminal.state !== "closed");
  if (current !== undefined && visible.some((terminal) => terminal.id === current)) return current;
  return visible.find((terminal) => terminal.state === "running")?.id ?? visible[0]?.id;
}

/**
 * Projects a PTY byte stream onto a small text screen. The desktop terminal is
 * deliberately read-only apart from its command field, but Windows shells still
 * emit cursor movement and erase commands intended for a VT renderer. Rendering
 * those bytes in a plain <pre> leaks escape sequences and creates large blank
 * areas, so this model handles the screen commands used by cmd/PowerShell while
 * leaving colours and other presentation-only modes out of the DOM.
 */
export function renderTerminalBuffer(input: string, requestedColumns = 120, requestedRows = 40): string {
  const columns = Math.min(500, Math.max(20, Math.floor(requestedColumns)));
  const rows = Math.min(300, Math.max(5, Math.floor(requestedRows)));
  let screen: string[][] = Array.from({ length: rows }, () => []);
  const scrollback: string[] = [];
  let row = 0;
  let column = 0;
  let savedRow = 0;
  let savedColumn = 0;

  const lineText = (line: readonly string[]) => line.join("").replace(/\s+$/u, "");
  const scroll = () => {
    const first = screen.shift() ?? [];
    const text = lineText(first);
    if (text.length > 0) scrollback.push(text);
    if (scrollback.length > 2_000) scrollback.splice(0, scrollback.length - 2_000);
    screen.push([]);
    row = rows - 1;
  };
  const constrainCursor = () => {
    column = Math.min(columns - 1, Math.max(0, column));
    row = Math.max(0, row);
    while (row >= rows) scroll();
  };
  const paramsFor = (body: string): number[] => {
    const cleaned = body.replace(/^[?<>=!]+/u, "");
    if (cleaned.length === 0) return [];
    return cleaned.split(";").map((value) => {
      const parsed = Number.parseInt(value, 10);
      return Number.isFinite(parsed) ? parsed : 0;
    });
  };
  const positive = (params: readonly number[], index: number, fallback = 1) => {
    const value = params[index];
    return value === undefined || value === 0 ? fallback : value;
  };
  const eraseLine = (mode: number) => {
    if (mode === 2) screen[row] = [];
    else if (mode === 1) {
      const line = screen[row] ?? [];
      for (let index = 0; index <= column; index += 1) line[index] = " ";
    } else (screen[row] ?? []).splice(column);
  };
  const eraseDisplay = (mode: number) => {
    if (mode === 2 || mode === 3) {
      screen = Array.from({ length: rows }, () => []);
      row = 0;
      column = 0;
      if (mode === 3) scrollback.length = 0;
      return;
    }
    if (mode === 1) {
      for (let index = 0; index < row; index += 1) screen[index] = [];
      eraseLine(1);
      return;
    }
    eraseLine(0);
    for (let index = row + 1; index < rows; index += 1) screen[index] = [];
  };
  const handleCsi = (body: string, command: string) => {
    const params = paramsFor(body);
    switch (command) {
      case "A": row -= positive(params, 0); break;
      case "B": case "e": row += positive(params, 0); break;
      case "C": case "a": column += positive(params, 0); break;
      case "D": column -= positive(params, 0); break;
      case "E": row += positive(params, 0); column = 0; break;
      case "F": row -= positive(params, 0); column = 0; break;
      case "G": case "`": column = positive(params, 0) - 1; break;
      case "d": row = positive(params, 0) - 1; break;
      case "H": case "f":
        row = positive(params, 0) - 1;
        column = positive(params, 1) - 1;
        break;
      case "J": eraseDisplay(params[0] ?? 0); break;
      case "K": eraseLine(params[0] ?? 0); break;
      case "s": savedRow = row; savedColumn = column; break;
      case "u": row = savedRow; column = savedColumn; break;
      default: break;
    }
    constrainCursor();
  };

  for (let index = 0; index < input.length;) {
    const character = input[index]!;
    if (character === "\u001b") {
      const next = input[index + 1];
      if (next === "[") {
        let end = index + 2;
        while (end < input.length && !/[\u0040-\u007e]/u.test(input[end]!)) end += 1;
        if (end >= input.length) break;
        handleCsi(input.slice(index + 2, end), input[end]!);
        index = end + 1;
        continue;
      }
      if (next === "]" || next === "P" || next === "_") {
        let end = index + 2;
        while (end < input.length && input[end] !== "\u0007" && !(input[end] === "\u001b" && input[end + 1] === "\\")) end += 1;
        index = end >= input.length ? input.length : end + (input[end] === "\u001b" ? 2 : 1);
        continue;
      }
      index += Math.min(2, input.length - index);
      continue;
    }
    if (character === "\r") column = 0;
    else if (character === "\n") { row += 1; constrainCursor(); }
    else if (character === "\b") column = Math.max(0, column - 1);
    else if (character === "\t") column = Math.min(columns - 1, (Math.floor(column / 8) + 1) * 8);
    else if (character >= " ") {
      const line = screen[row] ?? (screen[row] = []);
      while (line.length < column) line.push(" ");
      line[column] = character;
      column += 1;
      if (column >= columns) { column = 0; row += 1; constrainCursor(); }
    }
    index += 1;
  }

  return [...scrollback, ...screen.map(lineText)].filter((line) => line.length > 0).join("\n");
}
