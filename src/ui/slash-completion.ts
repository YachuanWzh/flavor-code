export type SlashCandidateKind = "command" | "plugin" | "tool" | "skill";

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

export interface SlashCandidatePresentation {
  marker: "› " | "  ";
  rowStyle: Record<string, never>;
  matchStyle: { color: "ansi:cyan"; bold: true };
}

const CANDIDATE_KIND_PRIORITY: Record<SlashCandidateKind, number> = {
  skill: 0,
  plugin: 0,
  command: 1,
  tool: 2,
};

const SLASH_DESCRIPTION_CHAR_LIMIT = 240;

/**
 * Command metadata comes from plugins and Skill frontmatter, so it may contain
 * paragraphs or very large usage guides. The terminal completion menu reserves
 * exactly one row per candidate; keep that invariant before the text reaches
 * Yoga, rather than relying on visual overflow clipping after layout.
 */
export function normalizeSlashDescription(description: string): string {
  const singleLine = description.replace(/\s+/gu, " ").trim();
  const points = [...singleLine];
  if (points.length <= SLASH_DESCRIPTION_CHAR_LIMIT) return singleLine;
  return `${points.slice(0, SLASH_DESCRIPTION_CHAR_LIMIT - 1).join("")}…`;
}

function optionalDescription(description: string | undefined): string | undefined {
  if (description === undefined) return undefined;
  const normalized = normalizeSlashDescription(description);
  return normalized.length === 0 ? undefined : normalized;
}

export function slashCandidatePresentation(selected: boolean): SlashCandidatePresentation {
  return {
    marker: selected ? "› " : "  ",
    rowStyle: {},
    matchStyle: { color: "ansi:cyan", bold: true },
  };
}

export function buildSlashCandidates(
  commands: readonly { name: string; description: string }[],
  plugins: readonly { name: string; description?: string }[],
  skills: readonly { name: string; description: string; source: string }[],
  tools: readonly { name: string; description?: string }[] = [],
): SlashCandidate[] {
  const candidates = new Map<string, SlashCandidate>();
  for (const command of commands) {
    candidates.set(command.name, {
      name: command.name,
      kind: "command",
      description: normalizeSlashDescription(command.description),
    });
  }
  for (const plugin of plugins) {
    if (!candidates.has(plugin.name)) {
      const description = optionalDescription(plugin.description);
      candidates.set(plugin.name, description === undefined
        ? { name: plugin.name, kind: "plugin" }
        : { name: plugin.name, kind: "plugin", description });
    }
  }
  for (const tool of tools) {
    if (!candidates.has(tool.name)) {
      const description = optionalDescription(tool.description);
      candidates.set(tool.name, description === undefined
        ? { name: tool.name, kind: "tool" }
        : { name: tool.name, kind: "tool", description });
    }
  }
  for (const skill of skills) {
    if (!candidates.has(skill.name)) {
      candidates.set(skill.name, {
        name: skill.name,
        kind: "skill",
        description: normalizeSlashDescription(skill.description),
        source: skill.source,
      });
    }
  }
  return [...candidates.values()];
}

export function completedSlashTokenLength(
  input: string,
  candidates: readonly SlashCandidate[],
  menuOpen: boolean,
): number {
  if (menuOpen) return 0;
  const points = [...input];
  if (points[0] !== "/") return 0;
  const whitespace = points.findIndex((point) => /\s/u.test(point));
  let tokenEnd = whitespace < 0 ? points.length : whitespace;
  const name = points.slice(1, tokenEnd).join("");
  const matches = candidates.some((candidate) => candidate.name === name);
  return matches ? tokenEnd : 0;
}

export function completedSlashTokenPresentation(): { color: "rgb(120,155,255)"; bold: true } {
  return { color: "rgb(120,155,255)", bold: true };
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
      const kindPriority = CANDIDATE_KIND_PRIORITY[left.kind] - CANDIDATE_KIND_PRIORITY[right.kind];
      if (kindPriority !== 0) return kindPriority;
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

export function removeCompletedSlashSelection(
  input: string,
  tokenLength: number,
  cursor: number,
): { text: string; cursor: number } | null {
  if (tokenLength <= 0) return null;
  const points = [...input];
  const safeTokenLength = Math.min(points.length, tokenLength);
  const safeCursor = Math.max(safeTokenLength, Math.min(points.length, cursor));
  const textBetweenTokenAndCursor = points.slice(safeTokenLength, safeCursor).join("");
  if (!/^\s*$/u.test(textBetweenTokenAndCursor)) return null;

  return {
    text: points.slice(safeCursor).join(""),
    cursor: 0,
  };
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
