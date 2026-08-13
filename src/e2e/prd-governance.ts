import { createHash, randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";

export interface PrdSection {
  id: string;
  title: string;
  level: number;
  body: string;
  contentStart: number;
  contentEnd: number;
}

export interface PrdAcceptanceCriterion {
  id: string;
  text: string;
}

export interface ApprovedPrd {
  hash: string;
  approvedAt: string;
  criteria: PrdAcceptanceCriterion[];
}

export function hashPrd(markdown: string): string {
  return createHash("sha256").update(markdown, "utf8").digest("hex");
}

export function parsePrdSections(markdown: string): PrdSection[] {
  const headings = [...markdown.matchAll(/^(#{2,6})[ \t]+(.+?)[ \t]*$/gm)];
  const sections: PrdSection[] = [];
  const firstHeading = headings[0]?.index ?? markdown.length;
  const preamble = markdown.slice(0, firstHeading).trim();
  if (preamble.length > 0) {
    sections.push({
      id: "preamble", title: "文档说明", level: 0, body: preamble,
      contentStart: 0, contentEnd: firstHeading,
    });
  }
  const occurrences = new Map<string, number>();
  for (let index = 0; index < headings.length; index += 1) {
    const match = headings[index]!;
    const title = match[2]!.trim();
    const count = (occurrences.get(title) ?? 0) + 1;
    occurrences.set(title, count);
    const contentStart = match.index! + match[0].length;
    const contentEnd = headings[index + 1]?.index ?? markdown.length;
    sections.push({
      id: count === 1 ? title : `${title}-${count}`,
      title,
      level: match[1]!.length,
      body: markdown.slice(contentStart, contentEnd).trim(),
      contentStart,
      contentEnd,
    });
  }
  return sections;
}

export function extractAcceptanceCriteria(markdown: string): PrdAcceptanceCriterion[] {
  const candidates: Array<PrdAcceptanceCriterion & { score: number }> = [];
  let acceptanceSectionLevel: number | undefined;
  for (const line of markdown.split(/\r?\n/)) {
    const heading = line.match(/^\s*(#{1,6})\s+(.+?)\s*$/);
    if (heading !== null) {
      const level = heading[1]!.length;
      if (acceptanceSectionLevel !== undefined && level <= acceptanceSectionLevel) acceptanceSectionLevel = undefined;
      if (/(?:验收标准|验收准则|acceptance criteria)/i.test(heading[2]!)
        && !/(?:追踪|矩阵|映射|trace|mapping)/i.test(heading[2]!)) acceptanceSectionLevel = level;
    }
    const definition = line.match(/^\s*(?:[-*+]\s+(?:\[[ xX]\]\s*)?|#{1,6}\s+|\d+[.)]\s+)\[(AC-\d{3,})\][ \t]*(.+?)\s*$/i);
    const tableDefinition = line.match(/^\s*\|\s*\[(AC-\d{3,})\]\s*\|\s*([^|]+?)\s*\|/i);
    const plainDefinition = line.match(/^\s*\[(AC-\d{3,})\][ \t]+(.+?)\s*$/i);
    const reference = line.match(/\[(AC-\d{3,})\][ \t]*(.+?)\s*$/i);
    const match = definition ?? tableDefinition ?? plainDefinition ?? reference;
    if (match === null) continue;
    const text = match[2]!.replace(/[ \t]+#+[ \t]*$/, "").trim();
    if (text.length === 0) continue;
    candidates.push({ id: match[1]!.toUpperCase(), text,
      score: (acceptanceSectionLevel === undefined ? 0 : 10)
        + (definition !== null ? 3 : tableDefinition !== null ? 2 : plainDefinition !== null ? 1 : 0) });
  }
  const criteria = new Map<string, PrdAcceptanceCriterion & { score: number }>();
  for (const candidate of candidates) {
    const current = criteria.get(candidate.id);
    if (current === undefined || candidate.score > current.score) criteria.set(candidate.id, candidate);
  }
  return [...criteria.values()].map(({ id, text }) => ({ id, text }));
}

export function approvePrd(markdown: string, now = new Date()): ApprovedPrd {
  const criteria = extractAcceptanceCriteria(markdown);
  if (criteria.length === 0) {
    throw new Error("PRD must contain at least one uniquely identified acceptance criterion such as [AC-NNN]");
  }
  return { hash: hashPrd(markdown), approvedAt: now.toISOString(), criteria };
}

export async function assertApprovedPrd(path: string, approved: ApprovedPrd): Promise<ApprovedPrd> {
  const current = await readFile(path, "utf8");
  if (hashPrd(current) !== approved.hash) {
    throw new Error("PRD_LOCK_VIOLATION: confirmed PRD content changed after approval");
  }
  return approved;
}

export async function updatePrdSectionFile(
  path: string,
  input: { sectionId: string; body: string; expectedHash: string },
): Promise<{ markdown: string; hash: string; sections: PrdSection[] }> {
  const current = await readFile(path, "utf8");
  if (hashPrd(current) !== input.expectedHash) {
    throw new Error("PRD_EDIT_CONFLICT: the PRD changed; refresh before saving this section");
  }
  const section = parsePrdSections(current).find((item) => item.id === input.sectionId);
  if (section === undefined) throw new Error(`Unknown PRD section: ${input.sectionId}`);
  const body = input.body.trim();
  const replacement = section.level === 0 ? `${body}\n\n` : `\n\n${body}\n\n`;
  const markdown = `${current.slice(0, section.contentStart)}${replacement}${current.slice(section.contentEnd)}`;
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, markdown, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
  return { markdown, hash: hashPrd(markdown), sections: parsePrdSections(markdown) };
}
