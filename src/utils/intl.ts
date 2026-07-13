let graphemeSegmenter: Intl.Segmenter | undefined;
export function getGraphemeSegmenter(): Intl.Segmenter {
  return graphemeSegmenter ??= new Intl.Segmenter(undefined, { granularity: "grapheme" });
}
