const NEGATED_MEMORY_INTENT = /(?:不(?:要|用|必)?|别|无需)(?:再)?[^。！？.!?\n]{0,16}(?:记住|记下|记录|保存|长期记忆)|(?:do\s+not|don't|dont|never)\s+remember\b/iu;

const EXPLICIT_MEMORY_INTENTS = [
  /(?:^|[\s，。！？；,:;])(?:请|麻烦)?(?:你)?(?:帮我|替我)?记(?:住|下|一下|下来|着)/u,
  /(?:^|[\s，。！？；,:;])(?:这(?:个|条|点)|该项)?(?:要|需要|得)记住/u,
  /(?:保存|写入|加入|添加|记录)(?:到|进|至|在)?(?:项目)?长期记忆/u,
  /长期记忆(?:里|中)?(?:保存|写入|加入|添加|记录|记下)/u,
  /\b(?:please\s+)?remember\s+(?:that|this|my|the)\b/iu,
] as const;

/** Detects an explicit request to persist memory; it does not decide what is safe to store. */
export function isExplicitMemoryIntent(prompt: string): boolean {
  const normalized = prompt.normalize("NFKC").trim();
  if (!normalized || normalized.startsWith("/") || NEGATED_MEMORY_INTENT.test(normalized)) return false;
  return EXPLICIT_MEMORY_INTENTS.some((pattern) => pattern.test(normalized));
}
