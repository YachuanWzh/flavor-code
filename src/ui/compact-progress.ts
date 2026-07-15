export const COMPACT_PROGRESS_CELLS = 10;
export const COMPACT_PROGRESS_COMPLETE = "#5b8cff";
export const COMPACT_PROGRESS_REMAINING = "#525761";

export interface CompactProgressPresentation {
  progress: number;
  cells: Array<{ completed: boolean; color: string }>;
}

export function compactProgressPresentation(progress: number): CompactProgressPresentation {
  const normalized = Math.max(0, Math.min(100, Math.floor(progress / 10) * 10));
  const completed = normalized / 10;
  return {
    progress: normalized,
    cells: Array.from({ length: COMPACT_PROGRESS_CELLS }, (_, index) => ({
      completed: index < completed,
      color: index < completed ? COMPACT_PROGRESS_COMPLETE : COMPACT_PROGRESS_REMAINING,
    })),
  };
}
