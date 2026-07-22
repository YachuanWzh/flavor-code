import { jaccard, characterNgrams, memorySimilarity, normalizeForSimilarity, wordTokens } from "./similarity.js";
import type { MemoryHeat, MemoryReference } from "./types.js";

const HOT_WINDOW_MS = 7 * 24 * 60 * 60 * 1_000;
const COLD_AFTER_MS = 3 * 24 * 60 * 60 * 1_000;

export interface RankedMemoryReference {
  reference: MemoryReference;
  score: number;
  heat: MemoryHeat;
}

export function classifyMemoryHeat(reference: MemoryReference, now = new Date()): MemoryHeat {
  const cutoff = now.getTime() - HOT_WINDOW_MS;
  const recent = Object.values(reference.recalls).filter((value) => {
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) && timestamp >= cutoff && timestamp <= now.getTime();
  }).length;
  if (recent > 10) return "hot";
  const last = Math.max(Date.parse(reference.createdAt), ...Object.values(reference.recalls).map(Date.parse).filter(Number.isFinite));
  return now.getTime() - last > COLD_AFTER_MS ? "cold" : "normal";
}

export function rankMemoryReferences(
  references: readonly MemoryReference[], query: string,
  options: { now?: Date; topK: number; maxChars: number; minScore?: number },
): RankedMemoryReference[] {
  const now = options.now ?? new Date();
  const normalizedQuery = normalizeForSimilarity(query);
  const queryWords = wordTokens(normalizedQuery);
  const queryNgrams = characterNgrams(normalizedQuery);
  const ranked = references.map((reference): RankedMemoryReference => {
    const searchable = `${reference.summary} ${reference.keywords.join(" ")} ${reference.topicKey}`;
    const wordScore = jaccard(queryWords, wordTokens(searchable));
    const characterScore = jaccard(queryNgrams, characterNgrams(searchable));
    const keywordMatches = reference.keywords.filter((keyword) => normalizedQuery.includes(normalizeForSimilarity(keyword))).length;
    const keywordScore = reference.keywords.length === 0 ? 0 : keywordMatches / reference.keywords.length;
    const semanticFloor = memorySimilarity(reference.summary, query) * 0.15;
    const base = Math.max(semanticFloor, wordScore * 0.55 + characterScore * 0.25 + keywordScore * 0.2);
    const heat = classifyMemoryHeat(reference, now);
    return { reference, heat, score: base * (heat === "hot" ? 1.15 : heat === "cold" ? 0.75 : 1) };
  }).filter((item) => item.score >= (options.minScore ?? 0.05))
    .sort((left, right) => right.score - left.score || left.reference.id.localeCompare(right.reference.id));

  const selected: RankedMemoryReference[] = [];
  let chars = 0;
  for (const item of ranked) {
    if (selected.length >= options.topK) break;
    const size = item.reference.summary.length;
    if (chars + size > options.maxChars) continue;
    selected.push(item); chars += size;
  }
  return selected;
}
