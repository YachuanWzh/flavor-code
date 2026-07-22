export const MEMORY_TYPES = ["user", "feedback", "project", "reference"] as const;
export type MemoryType = (typeof MEMORY_TYPES)[number];

export interface MemoryCandidate {
  type: MemoryType;
  content: string;
}

export interface MemoryEntry extends MemoryCandidate {
  id: string;
}

