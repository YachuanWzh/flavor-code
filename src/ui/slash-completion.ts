export type SlashCandidateKind = "command" | "plugin" | "skill";

export interface SlashCandidate {
  name: string;
  kind: SlashCandidateKind;
  description?: string;
  source?: string;
}

export interface SlashCompletion {
  query: string;
  items: SlashCandidate[];
  selectedIndex: number;
  windowStart: number;
}

export function buildSlashCandidates(
  commands: readonly string[],
  plugins: readonly string[],
  skills: readonly { name: string; description: string; source: string }[],
): SlashCandidate[] {
  const candidates = new Map<string, SlashCandidate>();
  for (const name of commands) candidates.set(name, { name, kind: "command" });
  for (const name of plugins) {
    if (!candidates.has(name)) candidates.set(name, { name, kind: "plugin" });
  }
  for (const skill of skills) {
    if (!candidates.has(skill.name)) {
      candidates.set(skill.name, {
        name: skill.name,
        kind: "skill",
        description: skill.description,
        source: skill.source,
      });
    }
  }
  return [...candidates.values()];
}

export function deriveSlashCompletion(
  input: string,
  cursor: number,
  candidates: readonly SlashCandidate[],
  selectedIndex: number,
  visibleLimit = 6,
): SlashCompletion | null {
  const points = [...input];
  const safeCursor = Math.max(0, Math.min(points.length, cursor));
  if (points[0] !== "/") return null;
  const whitespace = points.findIndex((point) => /\s/u.test(point));
  const tokenEnd = whitespace < 0 ? points.length : whitespace;
  if (safeCursor < 1 || safeCursor > tokenEnd) return null;

  const query = points.slice(1, tokenEnd).join("");
  const normalized = query.toLowerCase();
  const items = candidates
    .filter(({ name }) => name.toLowerCase().includes(normalized))
    .sort((left, right) => {
      const leftPrefix = left.name.toLowerCase().startsWith(normalized);
      const rightPrefix = right.name.toLowerCase().startsWith(normalized);
      if (leftPrefix !== rightPrefix) return leftPrefix ? -1 : 1;
      return left.name.localeCompare(right.name);
    });
  if (items.length === 0) return null;

  const selected = Math.max(0, Math.min(items.length - 1, selectedIndex));
  const limit = Math.max(1, visibleLimit);
  const windowStart = Math.max(0, Math.min(selected, items.length - limit));
  return { query, items, selectedIndex: selected, windowStart };
}

export function moveSlashSelection(index: number, delta: -1 | 1, count: number): number {
  if (count <= 0) return 0;
  return (index + delta + count) % count;
}

export function completeSlashSelection(
  input: string,
  cursor: number,
  name: string,
): { text: string; cursor: number } {
  const points = [...input];
  const safeCursor = Math.max(0, Math.min(points.length, cursor));
  const tokenEndOffset = points.slice(safeCursor).findIndex((point) => /\s/u.test(point));
  const tokenEnd = tokenEndOffset < 0 ? points.length : safeCursor + tokenEndOffset;
  const suffix = points.slice(tokenEnd).join("").replace(/^\s*/u, "");
  const prefix = `/${name} `;
  return { text: prefix + suffix, cursor: [...prefix].length };
}

export function matchRanges(value: string, query: string): Array<[number, number]> {
  if (query.length === 0) return [];
  const normalizedValue = value.toLowerCase();
  const normalizedQuery = query.toLowerCase();
  const ranges: Array<[number, number]> = [];
  let start = 0;
  while (start < normalizedValue.length) {
    const index = normalizedValue.indexOf(normalizedQuery, start);
    if (index < 0) break;
    ranges.push([index, index + normalizedQuery.length]);
    start = index + normalizedQuery.length;
  }
  return ranges;
}
