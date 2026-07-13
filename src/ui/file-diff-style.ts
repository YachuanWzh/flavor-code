import type { FileDiffLine } from "../tools/types.js";

export interface FileDiffLineStyle {
  backgroundColor?: string;
  markerColor: string;
  contentColor: string;
}

const CONTENT = "#f8f8f2";

export function fileDiffLineStyle(kind: FileDiffLine["kind"]): FileDiffLineStyle {
  if (kind === "removed") {
    return { backgroundColor: "#3d0100", markerColor: "#ff5f56", contentColor: CONTENT };
  }
  if (kind === "added") {
    return { backgroundColor: "#022800", markerColor: "#50c878", contentColor: CONTENT };
  }
  return { markerColor: CONTENT, contentColor: CONTENT };
}
