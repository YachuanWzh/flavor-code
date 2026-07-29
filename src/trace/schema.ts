import { z } from "zod";

export const TraceKindSchema = z.enum(["command", "response", "output", "queue", "history", "verification"]);
export type TraceKind = z.infer<typeof TraceKindSchema>;

export const TraceRecordSchema = z.object({
  version: z.literal(1),
  sequence: z.number().int().positive(),
  timestamp: z.string().datetime(),
  sessionId: z.string().min(1),
  kind: TraceKindSchema,
  payload: z.unknown(),
}).strict();

export type TraceRecord = z.infer<typeof TraceRecordSchema>;
