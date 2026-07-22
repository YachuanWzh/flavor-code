export function normalizeForSimilarity(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ").trim();
}

export function jaccard(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
  if (left.size === 0 && right.size === 0) return 1;
  if (left.size === 0 || right.size === 0) return 0;
  let intersection = 0;
  for (const item of left) if (right.has(item)) intersection += 1;
  return intersection / (left.size + right.size - intersection);
}

export function wordTokens(value: string): Set<string> {
  return new Set(normalizeForSimilarity(value).split(" ").filter((token) => token.length > 0));
}

export function characterNgrams(value: string, size = 3): Set<string> {
  const normalized = [...normalizeForSimilarity(value).replace(/\s+/g, "")];
  if (normalized.length === 0) return new Set();
  if (normalized.length <= size) return new Set([normalized.join("")]);
  return new Set(Array.from({ length: normalized.length - size + 1 }, (_, index) => normalized.slice(index, index + size).join("")));
}

export function memorySimilarity(left: string, right: string): number {
  const normalizedLeft = normalizeForSimilarity(left);
  const normalizedRight = normalizeForSimilarity(right);
  if (normalizedLeft === normalizedRight) return 1;
  const words = jaccard(wordTokens(normalizedLeft), wordTokens(normalizedRight));
  const leftBigrams = characterNgrams(normalizedLeft, 2);
  const rightBigrams = characterNgrams(normalizedRight, 2);
  const characters = Math.max(
    jaccard(leftBigrams, rightBigrams),
    jaccard(characterNgrams(normalizedLeft, 3), characterNgrams(normalizedRight, 3)),
    dice(leftBigrams, rightBigrams) * 0.9,
  );
  const score = Math.max(words, characters, words * 0.6 + characters * 0.4);
  // A tiny token substitution can invert a decision (npm/pnpm, allow/deny).
  // Keep it below the automatic duplicate band unless the token sets agree.
  return words < 1 && characters >= 0.9 ? Math.min(score, 0.89) : score;
}

function dice(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
  if (left.size === 0 && right.size === 0) return 1;
  let intersection = 0;
  for (const item of left) if (right.has(item)) intersection += 1;
  return (2 * intersection) / (left.size + right.size);
}
