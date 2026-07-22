export const MEMORY_TYPES = ["user", "feedback", "project", "reference"] as const;
export type MemoryType = (typeof MEMORY_TYPES)[number];

export interface MemoryCandidate {
  type: MemoryType;
  content: string;
}

export interface MemoryEntry extends MemoryCandidate {
  id: string;
}

export interface MemoryScores {
  durability: number;
  futureUtility: number;
  authority: number;
  nonDerivability: number;
}

export interface ScoredMemoryCandidate extends MemoryCandidate {
  summary: string;
  topicKey: string;
  keywords: string[];
  scores: MemoryScores;
}

export interface MemoryReference {
  id: string;
  type: MemoryType;
  taskId: string;
  summary: string;
  contentPath: string;
  topicKey: string;
  keywords: string[];
  createdAt: string;
  updatedAt: string;
  recallTotal: number;
  /** One timestamp per distinct recalling task. */
  recalls: Record<string, string>;
  relatedTo?: string[];
}

export type MemoryHeat = "hot" | "cold" | "normal";
