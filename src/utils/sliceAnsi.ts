// @ts-nocheck
import {
  type AnsiCode,
  ansiCodesToString,
  reduceAnsiCodes,
  tokenize,
  undoAnsiCodes,
} from "@alcalzone/ansi-tokenize";
import { stringWidth } from "../claude-ink/stringWidth.js";

const starts = (codes: AnsiCode[]): AnsiCode[] => codes.filter((code) => code.code !== code.endCode);

export default function sliceAnsi(str: string, start: number, end?: number): string {
  const tokens = tokenize(str);
  let active: AnsiCode[] = [];
  let position = 0;
  let result = "";
  let include = false;
  for (const token of tokens) {
    const width = token.type === "ansi" ? 0 : token.fullWidth ? 2 : stringWidth(token.value);
    if (end !== undefined && position >= end && (token.type === "ansi" || width > 0 || !include)) break;
    if (token.type === "ansi") {
      active.push(token);
      if (include) result += token.code;
      continue;
    }
    if (!include && position >= start) {
      if (start > 0 && width === 0) continue;
      include = true;
      active = starts(reduceAnsiCodes(active));
      result = ansiCodesToString(active);
    }
    if (include) result += token.value;
    position += width;
  }
  return result + ansiCodesToString(undoAnsiCodes(starts(reduceAnsiCodes(active))));
}
