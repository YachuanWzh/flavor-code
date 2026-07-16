import { basename } from "node:path";

export interface MentionCompletion {
  query: string;
  items: string[];
  selectedIndex: number;
  windowStart: number;
}

interface MentionToken {
  start: number;
  end: number;
  query: string;
}

export function buildMentionCandidates(paths: readonly string[]): string[] {
  return [...new Set(paths.map((path) => path.replaceAll("\\", "/")))]
    .sort(comparePaths);
}

export function deriveMentionCompletion(
  input: string,
  cursor: number,
  candidates: readonly string[],
  selectedIndex: number,
  visibleLimit = 6,
): MentionCompletion | null {
  const token = mentionTokenAtCursor(input, cursor);
  if (token === null) return null;
  const normalizedQuery = token.query.toLowerCase();
  const items = candidates
    .filter((path) => path.toLowerCase().includes(normalizedQuery))
    .sort((left, right) => {
      const rankDelta = mentionRank(left, normalizedQuery) - mentionRank(right, normalizedQuery);
      return rankDelta || comparePaths(left, right);
    });
  if (items.length === 0) return null;

  const selected = Math.max(0, Math.min(items.length - 1, selectedIndex));
  const limit = Math.max(1, visibleLimit);
  const windowStart = Math.max(0, Math.min(selected, items.length - limit));
  return { query: token.query, items, selectedIndex: selected, windowStart };
}

export function moveMentionSelection(index: number, delta: -1 | 1, count: number): number {
  if (count <= 0) return 0;
  return (index + delta + count) % count;
}

export function completeMentionSelection(
  input: string,
  cursor: number,
  path: string,
): { text: string; cursor: number } {
  const points = [...input];
  const token = mentionTokenAtCursor(input, cursor);
  const safeCursor = Math.max(0, Math.min(points.length, cursor));
  if (token === null) return { text: input, cursor: safeCursor };

  const escapedPath = path.replaceAll("\\", "/").replaceAll(" ", "\\ ");
  const inserted = `@${escapedPath} `;
  const prefix = points.slice(0, token.start).join("");
  const suffix = points.slice(token.end).join("").replace(/^\s*/u, "");
  return {
    text: prefix + inserted + suffix,
    cursor: [...prefix + inserted].length,
  };
}

function mentionTokenAtCursor(input: string, cursor: number): MentionToken | null {
  const points = [...input];
  const safeCursor = Math.max(0, Math.min(points.length, cursor));
  let start = safeCursor;
  while (start > 0 && !isTokenBoundary(points, start - 1)) start -= 1;
  if (points[start] !== "@" || safeCursor <= start) return null;

  let end = safeCursor;
  while (end < points.length && !isTokenBoundary(points, end)) end += 1;
  return {
    start,
    end,
    query: unescapeQuery(points.slice(start + 1, end).join("")),
  };
}

function isTokenBoundary(points: readonly string[], index: number): boolean {
  if (!/\s/u.test(points[index] ?? "")) return false;
  let slashCount = 0;
  for (let cursor = index - 1; cursor >= 0 && points[cursor] === "\\"; cursor -= 1) slashCount += 1;
  return slashCount % 2 === 0;
}

function unescapeQuery(value: string): string {
  return value.replace(/\\(\s)/gu, "$1");
}

function mentionRank(path: string, query: string): number {
  const normalizedPath = path.toLowerCase();
  const filename = basename(normalizedPath);
  if (filename.startsWith(query)) return 0;
  if (normalizedPath.startsWith(query)) return 1;
  return 2;
}

function comparePaths(left: string, right: string): number {
  return left.localeCompare(right, "en");
}
