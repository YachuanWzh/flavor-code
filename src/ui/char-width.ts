/**
 * Return the display width of a Unicode code point in a fixed-width terminal.
 *
 * - 2 for CJK ideographs, fullwidth forms, Hangul, Kana, and most emoji.
 * - 0 for combining marks, zero-width joiners, and other invisible characters.
 * - 1 for everything else (ASCII, Latin, Cyrillic, etc.).
 *
 * This is a heuristic based on Unicode East Asian Width conventions. It covers
 * the most common ranges and is intentionally zero-dependency so it stays fast
 * and reviewable.
 */
export function charWidth(codePoint: number): number {
  // Zero-width characters
  if (
    codePoint === 0x200B || // ZERO WIDTH SPACE
    codePoint === 0x200C || // ZERO WIDTH NON-JOINER
    codePoint === 0x200D || // ZERO WIDTH JOINER
    codePoint === 0xFEFF || // BOM / ZERO WIDTH NO-BREAK SPACE
    (codePoint >= 0x0300 && codePoint <= 0x036F) || // Combining Diacritical Marks
    (codePoint >= 0x0483 && codePoint <= 0x0489) || // Cyrillic combining marks
    (codePoint >= 0x0591 && codePoint <= 0x05BD) || // Hebrew combining marks
    (codePoint >= 0x0610 && codePoint <= 0x061A) || // Arabic combining marks
    (codePoint >= 0x064B && codePoint <= 0x065F) || // Arabic combining marks
    (codePoint >= 0x0670 && codePoint <= 0x0670) || // Arabic combining marks
    (codePoint >= 0x06D6 && codePoint <= 0x06DC) || // Arabic combining marks
    (codePoint >= 0x06DF && codePoint <= 0x06E4) || // Arabic combining marks
    (codePoint >= 0x06E7 && codePoint <= 0x06E8) || // Arabic combining marks
    (codePoint >= 0x06EA && codePoint <= 0x06ED) || // Arabic combining marks
    (codePoint >= 0x0711 && codePoint <= 0x0711) || // Syriac combining marks
    (codePoint >= 0x0730 && codePoint <= 0x074A) || // Syriac combining marks
    (codePoint >= 0x07A6 && codePoint <= 0x07B0) || // Thaana combining marks
    (codePoint >= 0x0900 && codePoint <= 0x0902) || // Devanagari combining marks
    (codePoint >= 0x093A && codePoint <= 0x093A) || // Devanagari combining marks
    (codePoint >= 0x093C && codePoint <= 0x093C) || // Devanagari combining marks
    (codePoint >= 0x0941 && codePoint <= 0x0948) || // Devanagari combining marks
    (codePoint >= 0x094D && codePoint <= 0x094D) || // Devanagari combining marks
    (codePoint >= 0x0951 && codePoint <= 0x0957) || // Devanagari combining marks
    (codePoint >= 0x0962 && codePoint <= 0x0963) || // Devanagari combining marks
    (codePoint >= 0x0981 && codePoint <= 0x0981) || // Bengali combining marks
    (codePoint >= 0x09BC && codePoint <= 0x09BC) || // Bengali combining marks
    (codePoint >= 0x09C1 && codePoint <= 0x09C4) || // Bengali combining marks
    (codePoint >= 0x09CD && codePoint <= 0x09CD) || // Bengali combining marks
    (codePoint >= 0x09E2 && codePoint <= 0x09E3) || // Bengali combining marks
    (codePoint >= 0x0A01 && codePoint <= 0x0A02) || // Gurmukhi combining marks
    (codePoint >= 0x0A3C && codePoint <= 0x0A3C) || // Gurmukhi combining marks
    (codePoint >= 0x0A41 && codePoint <= 0x0A42) || // Gurmukhi combining marks
    (codePoint >= 0x0A47 && codePoint <= 0x0A48) || // Gurmukhi combining marks
    (codePoint >= 0x0A4B && codePoint <= 0x0A4D) || // Gurmukhi combining marks
    (codePoint >= 0x0A70 && codePoint <= 0x0A71) || // Gurmukhi combining marks
    (codePoint >= 0x0A81 && codePoint <= 0x0A82) || // Gujarati combining marks
    (codePoint >= 0x0ABC && codePoint <= 0x0ABC) || // Gujarati combining marks
    (codePoint >= 0x0AC1 && codePoint <= 0x0AC5) || // Gujarati combining marks
    (codePoint >= 0x0AC7 && codePoint <= 0x0AC8) || // Gujarati combining marks
    (codePoint >= 0x0ACD && codePoint <= 0x0ACD) || // Gujarati combining marks
    (codePoint >= 0x0AE2 && codePoint <= 0x0AE3) || // Gujarati combining marks
    (codePoint >= 0x0B01 && codePoint <= 0x0B01) || // Oriya combining marks
    (codePoint >= 0x0B3C && codePoint <= 0x0B3C) || // Oriya combining marks
    (codePoint >= 0x0B3F && codePoint <= 0x0B3F) || // Oriya combining marks
    (codePoint >= 0x0B41 && codePoint <= 0x0B43) || // Oriya combining marks
    (codePoint >= 0x0B4D && codePoint <= 0x0B4D) || // Oriya combining marks
    (codePoint >= 0x0B56 && codePoint <= 0x0B56) || // Oriya combining marks
    (codePoint >= 0x0B82 && codePoint <= 0x0B82) || // Tamil combining marks
    (codePoint >= 0x0BC0 && codePoint <= 0x0BC0) || // Tamil combining marks
    (codePoint >= 0x0BCD && codePoint <= 0x0BCD) || // Tamil combining marks
    (codePoint >= 0x0C3E && codePoint <= 0x0C40) || // Telugu combining marks
    (codePoint >= 0x0C46 && codePoint <= 0x0C48) || // Telugu combining marks
    (codePoint >= 0x0C4A && codePoint <= 0x0C4D) || // Telugu combining marks
    (codePoint >= 0x0C55 && codePoint <= 0x0C56) || // Telugu combining marks
    (codePoint >= 0x0CBC && codePoint <= 0x0CBC) || // Kannada combining marks
    (codePoint >= 0x0CBF && codePoint <= 0x0CBF) || // Kannada combining marks
    (codePoint >= 0x0CC6 && codePoint <= 0x0CC6) || // Kannada combining marks
    (codePoint >= 0x0CCC && codePoint <= 0x0CCD) || // Kannada combining marks
    (codePoint >= 0x0CE2 && codePoint <= 0x0CE3) || // Kannada combining marks
    (codePoint >= 0x0D41 && codePoint <= 0x0D43) || // Malayalam combining marks
    (codePoint >= 0x0D4D && codePoint <= 0x0D4D) || // Malayalam combining marks
    (codePoint >= 0x0DCA && codePoint <= 0x0DCA) || // Sinhala combining marks
    (codePoint >= 0x0DD2 && codePoint <= 0x0DD4) || // Sinhala combining marks
    (codePoint >= 0x0DD6 && codePoint <= 0x0DD6) || // Sinhala combining marks
    (codePoint >= 0x0E31 && codePoint <= 0x0E31) || // Thai combining marks
    (codePoint >= 0x0E34 && codePoint <= 0x0E3A) || // Thai combining marks
    (codePoint >= 0x0E47 && codePoint <= 0x0E4E) || // Thai combining marks
    (codePoint >= 0x0EB1 && codePoint <= 0x0EB1) || // Lao combining marks
    (codePoint >= 0x0EB4 && codePoint <= 0x0EB9) || // Lao combining marks
    (codePoint >= 0x0EBB && codePoint <= 0x0EBC) || // Lao combining marks
    (codePoint >= 0x0EC8 && codePoint <= 0x0ECD) || // Lao combining marks
    (codePoint >= 0x0F18 && codePoint <= 0x0F19) || // Tibetan combining marks
    (codePoint >= 0x0F35 && codePoint <= 0x0F35) || // Tibetan combining marks
    (codePoint >= 0x0F37 && codePoint <= 0x0F37) || // Tibetan combining marks
    (codePoint >= 0x0F39 && codePoint <= 0x0F39) || // Tibetan combining marks
    (codePoint >= 0x0F71 && codePoint <= 0x0F7E) || // Tibetan combining marks
    (codePoint >= 0x0F80 && codePoint <= 0x0F84) || // Tibetan combining marks
    (codePoint >= 0x0F86 && codePoint <= 0x0F87) || // Tibetan combining marks
    (codePoint >= 0x0F90 && codePoint <= 0x0F97) || // Tibetan combining marks
    (codePoint >= 0x0F99 && codePoint <= 0x0FBC) || // Tibetan combining marks
    (codePoint >= 0x0FC6 && codePoint <= 0x0FC6) || // Tibetan combining marks
    (codePoint >= 0x1032 && codePoint <= 0x1037) || // Myanmar combining marks
    (codePoint >= 0x1039 && codePoint <= 0x103A) || // Myanmar combining marks
    (codePoint >= 0x103D && codePoint <= 0x103E) || // Myanmar combining marks
    (codePoint >= 0x1058 && codePoint <= 0x1059) || // Myanmar combining marks
    (codePoint >= 0x105E && codePoint <= 0x1060) || // Myanmar combining marks
    (codePoint >= 0x1071 && codePoint <= 0x1074) || // Myanmar combining marks
    (codePoint >= 0x1082 && codePoint <= 0x1082) || // Myanmar combining marks
    (codePoint >= 0x1085 && codePoint <= 0x1086) || // Myanmar combining marks
    (codePoint >= 0x108D && codePoint <= 0x108D) || // Myanmar combining marks
    (codePoint >= 0x135D && codePoint <= 0x135F) || // Ethiopic combining marks
    (codePoint >= 0x1712 && codePoint <= 0x1714) || // Tagalog combining marks
    (codePoint >= 0x1732 && codePoint <= 0x1734) || // Hanunoo combining marks
    (codePoint >= 0x1752 && codePoint <= 0x1753) || // Buhid combining marks
    (codePoint >= 0x1772 && codePoint <= 0x1773) || // Tagbanwa combining marks
    (codePoint >= 0x17B4 && codePoint <= 0x17B5) || // Khmer combining marks
    (codePoint >= 0x17B7 && codePoint <= 0x17BD) || // Khmer combining marks
    (codePoint >= 0x17C6 && codePoint <= 0x17C6) || // Khmer combining marks
    (codePoint >= 0x17C9 && codePoint <= 0x17D3) || // Khmer combining marks
    (codePoint >= 0x17DD && codePoint <= 0x17DD) || // Khmer combining marks
    (codePoint >= 0x180B && codePoint <= 0x180D) || // Mongolian combining marks
    (codePoint >= 0x18A9 && codePoint <= 0x18A9) || // Mongolian combining marks
    (codePoint >= 0x1920 && codePoint <= 0x1922) || // Limbu combining marks
    (codePoint >= 0x1927 && codePoint <= 0x1928) || // Limbu combining marks
    (codePoint >= 0x1932 && codePoint <= 0x1932) || // Limbu combining marks
    (codePoint >= 0x1939 && codePoint <= 0x193B) || // Limbu combining marks
    (codePoint >= 0x1A17 && codePoint <= 0x1A18) || // Buginese combining marks
    (codePoint >= 0x1B00 && codePoint <= 0x1B03) || // Balinese combining marks
    (codePoint >= 0x1B34 && codePoint <= 0x1B34) || // Balinese combining marks
    (codePoint >= 0x1B36 && codePoint <= 0x1B3A) || // Balinese combining marks
    (codePoint >= 0x1B3C && codePoint <= 0x1B3C) || // Balinese combining marks
    (codePoint >= 0x1B42 && codePoint <= 0x1B42) || // Balinese combining marks
    (codePoint >= 0x1B6B && codePoint <= 0x1B73) || // Balinese combining marks
    (codePoint >= 0x1DC0 && codePoint <= 0x1DFF) || // Combining Diacritical Marks Supplement
    (codePoint >= 0x20D0 && codePoint <= 0x20F0) || // Combining Diacritical Marks for Symbols
    (codePoint >= 0x2CEF && codePoint <= 0x2CF1) || // Coptic combining marks
    (codePoint >= 0x2D7F && codePoint <= 0x2D7F) || // Tifinagh combining marks
    (codePoint >= 0x2DE0 && codePoint <= 0x2DFF) || // Cyrillic Extended-A combining marks
    (codePoint >= 0xA66F && codePoint <= 0xA672) || // Cyrillic Extended-B combining marks
    (codePoint >= 0xA674 && codePoint <= 0xA67D) || // Cyrillic Extended-B combining marks
    (codePoint >= 0xA69E && codePoint <= 0xA69F) || // Cyrillic Extended-B combining marks
    (codePoint >= 0xA6F0 && codePoint <= 0xA6F1) || // Bamum combining marks
    (codePoint >= 0xA802 && codePoint <= 0xA802) || // Syloti Nagri combining marks
    (codePoint >= 0xA806 && codePoint <= 0xA806) || // Syloti Nagri combining marks
    (codePoint >= 0xA80B && codePoint <= 0xA80B) || // Syloti Nagri combining marks
    (codePoint >= 0xA825 && codePoint <= 0xA826) || // Syloti Nagri combining marks
    (codePoint >= 0xA8C4 && codePoint <= 0xA8C4) || // Saurashtra combining marks
    (codePoint >= 0xA8E0 && codePoint <= 0xA8F1) || // Devanagari Extended combining marks
    (codePoint >= 0xA926 && codePoint <= 0xA92D) || // Kayah Li combining marks
    (codePoint >= 0xA947 && codePoint <= 0xA951) || // Rejang combining marks
    (codePoint >= 0xA980 && codePoint <= 0xA982) || // Javanese combining marks
    (codePoint >= 0xA9B3 && codePoint <= 0xA9B3) || // Javanese combining marks
    (codePoint >= 0xA9B6 && codePoint <= 0xA9B9) || // Javanese combining marks
    (codePoint >= 0xA9BC && codePoint <= 0xA9BC) || // Javanese combining marks
    (codePoint >= 0xAA29 && codePoint <= 0xAA2E) || // Cham combining marks
    (codePoint >= 0xAA31 && codePoint <= 0xAA32) || // Cham combining marks
    (codePoint >= 0xAA35 && codePoint <= 0xAA36) || // Cham combining marks
    (codePoint >= 0xAA43 && codePoint <= 0xAA43) || // Cham combining marks
    (codePoint >= 0xAA4C && codePoint <= 0xAA4C) || // Cham combining marks
    (codePoint >= 0xAAB0 && codePoint <= 0xAAB0) || // Tai Viet combining marks
    (codePoint >= 0xAAB2 && codePoint <= 0xAAB4) || // Tai Viet combining marks
    (codePoint >= 0xAAB7 && codePoint <= 0xAAB8) || // Tai Viet combining marks
    (codePoint >= 0xAABE && codePoint <= 0xAABF) || // Tai Viet combining marks
    (codePoint >= 0xAAC1 && codePoint <= 0xAAC1) || // Tai Viet combining marks
    (codePoint >= 0xABE5 && codePoint <= 0xABE5) || // Meetei Mayek combining marks
    (codePoint >= 0xABE8 && codePoint <= 0xABE8) || // Meetei Mayek combining marks
    (codePoint >= 0xABED && codePoint <= 0xABED) || // Meetei Mayek combining marks
    (codePoint >= 0xFB1E && codePoint <= 0xFB1E) || // Hebrew combining marks
    (codePoint >= 0xFE00 && codePoint <= 0xFE0F) || // Variation Selectors
    (codePoint >= 0xFE20 && codePoint <= 0xFE2F) || // Combining Half Marks
    (codePoint >= 0xE0100 && codePoint <= 0xE01EF)    // Variation Selectors Supplement
  ) {
    return 0;
  }

  // Wide characters (2 columns)
  if (
    (codePoint >= 0x1100 && codePoint <= 0x115F) ||   // Hangul Jamo
    (codePoint >= 0x2329 && codePoint <= 0x232A) ||   // Left/Right-pointing angle bracket
    (codePoint >= 0x2E80 && codePoint <= 0x303E) ||   // CJK Radicals Supplement, Kangxi Radicals, CJK Symbols
    (codePoint >= 0x3040 && codePoint <= 0x33BF) ||   // Hiragana, Katakana, Bopomofo, Hangul Compatibility, Kanbun, CJK Strokes, Enclosed CJK
    (codePoint >= 0x3400 && codePoint <= 0x4DBF) ||   // CJK Unified Ideographs Extension A
    (codePoint >= 0x4E00 && codePoint <= 0xA4CF) ||   // CJK Unified Ideographs, Yi Syllables, Yi Radicals
    (codePoint >= 0xA960 && codePoint <= 0xA97C) ||   // Hangul Jamo Extended-A
    (codePoint >= 0xAC00 && codePoint <= 0xD7A3) ||   // Hangul Syllables
    (codePoint >= 0xF900 && codePoint <= 0xFAFF) ||   // CJK Compatibility Ideographs
    (codePoint >= 0xFE10 && codePoint <= 0xFE19) ||   // Vertical forms
    (codePoint >= 0xFE30 && codePoint <= 0xFE6F) ||   // CJK Compatibility Forms, Small Form Variants
    (codePoint >= 0xFF01 && codePoint <= 0xFF60) ||   // Fullwidth Forms
    (codePoint >= 0xFFE0 && codePoint <= 0xFFE6) ||   // Fullwidth Signs
    (codePoint >= 0x1B000 && codePoint <= 0x1B2FF) || // Kana Supplement, Kana Extended-A, Small Kana Extension
    (codePoint >= 0x1F004 && codePoint <= 0x1F004) || // Mahjong tile
    (codePoint >= 0x1F0CF && codePoint <= 0x1F0CF) || // Playing card
    (codePoint >= 0x1F100 && codePoint <= 0x1F9FF) || // Enclosed Alphanumeric Supplement, Emoticons, Transport, etc.
    (codePoint >= 0x1FA00 && codePoint <= 0x1FA6F) || // Chess Symbols
    (codePoint >= 0x1FA70 && codePoint <= 0x1FAFF) || // Symbols and Pictographs Extended-A
    (codePoint >= 0x20000 && codePoint <= 0x2FFFD) || // CJK Unified Ideographs Extension B–G, CJK Compatibility Supplement
    (codePoint >= 0x30000 && codePoint <= 0x3FFFD)    // CJK Unified Ideographs Extension H
  ) {
    return 2;
  }

  // Narrow / neutral characters (1 column)
  return 1;
}
