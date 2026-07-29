import { readFile } from "node:fs/promises";

import { TraceRecordSchema, type TraceRecord } from "./schema.js";

export async function replayTrace(path: string, sessionId?: string): Promise<TraceRecord[]> {
  const raw = await readFile(path, "utf8");
  const records = raw.split(/\r?\n/).filter(Boolean).map((line) => TraceRecordSchema.parse(JSON.parse(line)));
  let previous = 0;
  for (const record of records) {
    if (record.sequence <= previous) throw new Error("Trace sequence is not strictly increasing");
    previous = record.sequence;
  }
  return sessionId === undefined ? records : records.filter((record) => record.sessionId === sessionId);
}

export async function* replayOutputEvents(path: string, sessionId?: string): AsyncIterable<unknown> {
  const records = await replayTrace(path, sessionId);
  for (const record of records) {
    if (record.kind === "output") yield record.payload;
  }
}
