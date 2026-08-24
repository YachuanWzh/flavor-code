import type { HarnessJournalRecord } from "./journal.js";

/** Mechanical replay invariants owned by the durable harness package. */
export function harnessInvariantViolations(records: readonly HarnessJournalRecord[]): string[] {
  const violations: string[] = [];
  const queues = new Set<string>();
  const tools = new Set<string>();
  const models = new Set<string>();
  const turns = new Set<string>();
  records.forEach((record, index) => {
    if (record.sequence !== index + 1) violations.push(`sequence ${record.sequence} is not ${index + 1}`);
    const id = typeof record.payload.id === "string" ? record.payload.id : "";
    if (record.type === "queue.admitted") {
      if (queues.has(id)) violations.push(`queue ${id} was admitted twice`);
      queues.add(id);
    } else if (record.type === "queue.claimed" || record.type === "queue.released") {
      if (!queues.has(id)) violations.push(`${record.type} references unknown queue ${id}`);
    } else if (record.type === "queue.acked") {
      if (!queues.delete(id)) violations.push(`queue.acked references unknown queue ${id}`);
    } else if (record.type === "tool.started") {
      if (tools.has(id)) violations.push(`tool ${id} was started twice`);
      tools.add(id);
    } else if (record.type === "tool.completed" || record.type === "tool.interrupted") {
      if (!tools.delete(id)) violations.push(`${record.type} references unknown tool ${id}`);
    } else if (record.type === "model.requested") {
      if (models.has(id)) violations.push(`model ${id} was requested twice`);
      if (!Array.isArray(record.payload.messages)) violations.push(`model ${id} has no replayable messages`);
      models.add(id);
    } else if (record.type === "model.completed") {
      if (!models.delete(id)) violations.push(`model.completed references unknown model ${id}`);
    } else if (record.type === "turn.started") {
      if (turns.has(id)) violations.push(`turn ${id} was started twice`);
      if (!("prompt" in record.payload)) violations.push(`turn ${id} has no replayable prompt`);
      turns.add(id);
    } else if (record.type === "turn.completed" || record.type === "turn.interrupted") {
      if (!turns.delete(id)) violations.push(`${record.type} references unknown turn ${id}`);
    }
  });
  return violations;
}

export function assertHarnessInvariants(records: readonly HarnessJournalRecord[]): void {
  const violations = harnessInvariantViolations(records);
  if (violations.length > 0) throw new Error(`Harness invariant violation: ${violations.join("; ")}`);
}
