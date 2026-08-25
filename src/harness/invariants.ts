import type { HarnessJournalRecord } from "./journal.js";

/** Mechanical replay invariants owned by the durable harness package. */
export function harnessInvariantViolations(records: readonly HarnessJournalRecord[]): string[] {
  const violations: string[] = [];
  const queues = new Set<string>();
  const tools = new Set<string>();
  const models = new Set<string>();
  const turns = new Set<string>();
  const firstSequence = records[0]?.sequence ?? 1;
  records.forEach((record, index) => {
    const expectedSequence = firstSequence + index;
    if (record.sequence !== expectedSequence) violations.push(`sequence ${record.sequence} is not ${expectedSequence}`);
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
      if (!isHash(record.payload.messagesHash)) violations.push(`model ${id} has no valid messages hash`);
      models.add(id);
    } else if (record.type === "model.completed") {
      if (!models.delete(id)) violations.push(`model.completed references unknown model ${id}`);
    } else if (record.type === "turn.started") {
      if (turns.has(id)) violations.push(`turn ${id} was started twice`);
      if (!isHash(record.payload.promptHash)) violations.push(`turn ${id} has no valid prompt hash`);
      turns.add(id);
    } else if (record.type === "turn.completed" || record.type === "turn.interrupted") {
      if (!turns.delete(id)) violations.push(`${record.type} references unknown turn ${id}`);
    }
  });
  return violations;
}

function isHash(value: unknown): boolean {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

export function assertHarnessInvariants(records: readonly HarnessJournalRecord[]): void {
  const violations = harnessInvariantViolations(records);
  if (violations.length > 0) throw new Error(`Harness invariant violation: ${violations.join("; ")}`);
}
