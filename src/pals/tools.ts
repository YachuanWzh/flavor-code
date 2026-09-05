import { z } from "zod";

import type { ToolDefinition } from "../tools/types.js";
import {
  CoWorkPlanSchema,
  MAX_COMPLETION_DETAIL_BYTES,
  MAX_MESSAGE_BYTES,
  MIN_UUID_PREFIX_LENGTH,
  normalizePalIdentity,
  PalTargetSchema,
  type BrokerEvent,
  type CoWorkParticipant,
  type CoWorkPlan,
  type CoWorkSnapshot,
  type DeliveryReceipt,
  type PalPresence,
} from "./protocol.js";
import type { CoWorkAction } from "./client.js";

export interface PalClientLike {
  start(): Promise<PalPresence>;
  list(): Promise<PalPresence[]>;
  rename(alias: string): Promise<PalPresence>;
  sendTask(target: string, message: string): Promise<DeliveryReceipt>;
  sendChat(target: string, message: string): Promise<DeliveryReceipt>;
  startCoWork(input: { coWorkId?: string; goal: string; participants: CoWorkParticipant[] }): Promise<CoWorkSnapshot>;
  coWorkAction(action: CoWorkAction): Promise<CoWorkSnapshot>;
  coWorkStatus(coWorkId: string): Promise<CoWorkSnapshot>;
  integrateCoWork(input: { coWorkId: string; epoch: number; planHash: string; passed: boolean; evidence: string }): Promise<CoWorkSnapshot>;
  cancelCoWork(coWorkId: string, reason: string): Promise<CoWorkSnapshot>;
  subscribe(listener: (event: BrokerEvent) => void): () => void;
  close(): Promise<void>;
}

export interface PalsToolOptions {
  selfId: string;
  shareGuard?: CollaborationShareGuard;
}

export interface CollaborationShareGuardOptions {
  redact: (value: string) => string;
  maxBytes?: number;
}

const DEFAULT_SHARE_BUDGET_BYTES = 128 * 1024;

/** Runtime-scoped guard for content emitted by model-facing collaboration tools. */
export class CollaborationShareGuard {
  private readonly redact: (value: string) => string;
  private readonly maxBytes: number;
  private sharedBytes = 0;

  constructor(options: CollaborationShareGuardOptions) {
    if (!Number.isSafeInteger(options.maxBytes ?? DEFAULT_SHARE_BUDGET_BYTES) || (options.maxBytes ?? DEFAULT_SHARE_BUDGET_BYTES) <= 0) {
      throw new Error("Collaboration sharing budget must be a positive integer");
    }
    this.redact = options.redact;
    this.maxBytes = options.maxBytes ?? DEFAULT_SHARE_BUDGET_BYTES;
  }

  protect(value: string): string {
    const redacted = this.redact(value);
    const bytes = Buffer.byteLength(redacted, "utf8");
    if (bytes > this.maxBytes - this.sharedBytes) throw new Error("Collaboration sharing budget exhausted");
    this.sharedBytes += bytes;
    return redacted;
  }
}

const Uuid = z.uuid();
const Hash = z.string().regex(/^[a-f0-9]{64}$/);
const Target = PalTargetSchema;
const BoundedText = z.string().trim().min(1).refine(
  (value) => Buffer.byteLength(value, "utf8") <= MAX_MESSAGE_BYTES,
  `Text must not exceed ${MAX_MESSAGE_BYTES} UTF-8 bytes`,
);
const CompletionEvidence = z.string().trim().min(1).refine(
  (value) => Buffer.byteLength(value, "utf8") <= MAX_COMPLETION_DETAIL_BYTES,
  `Completion evidence must not exceed ${MAX_COMPLETION_DETAIL_BYTES} UTF-8 bytes`,
);
const EmptyInput = z.object({}).strict();
const StateInput = z.object({ coWorkId: Uuid }).strict();
const TokenInput = z.object({ coWorkId: Uuid, epoch: z.number().int().positive(), planHash: Hash }).strict();
const SendInput = z.object({ target: Target, message: BoundedText, coWorkId: Uuid.optional() }).strict();
const PlanInput = z.object({ plan: CoWorkPlanSchema }).strict();
const ProgressInput = z.object({ coWorkId: Uuid, target: Target, detail: BoundedText }).strict();
const CompleteInput = TokenInput.extend({ passed: z.boolean(), detail: CompletionEvidence }).strict();
const IntegrateInput = TokenInput.extend({ passed: z.boolean(), evidence: CompletionEvidence }).strict();

const sharedBytes = (...values: string[]): number => values.reduce((total, value) => total + Buffer.byteLength(value, "utf8"), 0);

function resolvePresence(presences: readonly PalPresence[], target: string): PalPresence | undefined {
  const normalized = normalizePalIdentity(target);
  const exact = presences.find((pal) => pal.id.toLowerCase() === normalized || normalizePalIdentity(pal.alias) === normalized);
  if (exact !== undefined) return exact;
  if (normalized.length < MIN_UUID_PREFIX_LENGTH) return undefined;
  const prefix = presences.filter((pal) => pal.id.toLowerCase().startsWith(normalized));
  return prefix.length === 1 ? prefix[0] : undefined;
}

async function assertCurrentToken(client: PalClientLike, input: z.infer<typeof TokenInput>): Promise<CoWorkSnapshot> {
  const current = await client.coWorkStatus(input.coWorkId);
  if (current.epoch !== input.epoch || current.planHash !== input.planHash) {
    throw new Error("Co-work epoch and planHash must match the current canonical plan");
  }
  return current;
}

function assertRequiredParticipant(state: CoWorkSnapshot, selfId: string): void {
  if (!state.participants.some(({ palId, required }) => palId === selfId && required)) {
    throw new Error("Optional observers cannot change co-work lifecycle state; a required participant must perform this action");
  }
}

async function assertSendTarget(client: PalClientLike, target: string, coWorkId?: string): Promise<string> {
  const active = resolvePresence(await client.list(), target);
  if (active !== undefined) return active.id;
  if (coWorkId !== undefined) {
    const state = await client.coWorkStatus(coWorkId);
    const participant = state.participants.find(({ palId }) => palId.toLowerCase() === target.toLowerCase());
    if (participant !== undefined && state.acceptedParticipantIds.includes(participant.palId)) return participant.palId;
  }
  throw new Error(`Pal '${target}' is neither active nor an accepted co-work member`);
}

export function createPalsTools(client: PalClientLike, options: PalsToolOptions): ToolDefinition<unknown>[] {
  const common = { agents: ["main"] as const, paths: () => [] };
  const onceOnlyApproval = { permissions: () => ({ allowAlways: false as const }) };
  const shareGuard = options.shareGuard ?? new CollaborationShareGuard({ redact: (value) => value });
  return [
    {
      ...common,
      name: "PalsList",
      description: "List active local Flavor peers using bounded identity and presence fields",
      inputSchema: EmptyInput,
      execute: async (_input, signal) => {
        signal.throwIfAborted();
        return (await client.list()).map(({ id, alias, connectedAt, lastSeenAt }) => ({ id, alias, connectedAt, lastSeenAt }));
      },
    },
    {
      ...common,
      ...onceOnlyApproval,
      name: "PalSend",
      description: "Send a bounded collaboration fact to an active peer or accepted co-work member",
      inputSchema: SendInput,
      permissionInput: (input: z.infer<typeof SendInput>) => ({ target: input.target, sharedBytes: sharedBytes(input.message), ...(input.coWorkId === undefined ? {} : { coWorkId: input.coWorkId }) }),
      execute: async (input: z.infer<typeof SendInput>, signal: AbortSignal) => {
        signal.throwIfAborted();
        const recipientId = await assertSendTarget(client, input.target, input.coWorkId);
        signal.throwIfAborted();
        return client.sendChat(recipientId, shareGuard.protect(input.message));
      },
    },
    {
      ...common,
      name: "CoWorkState",
      description: "Read broker-authoritative co-work state, including integration owner and bounded participant completion assertions",
      inputSchema: StateInput,
      execute: async (input: z.infer<typeof StateInput>, signal: AbortSignal) => { signal.throwIfAborted(); return client.coWorkStatus(input.coWorkId); },
    },
    {
      ...common,
      ...onceOnlyApproval,
      name: "CoWorkPlan",
      description: "Submit a strict bounded co-work plan for participant review",
      inputSchema: PlanInput,
      permissionInput: (input: z.infer<typeof PlanInput>) => ({ coWorkId: input.plan.coWorkId, epoch: input.plan.epoch, taskCount: input.plan.tasks.length, sharedBytes: sharedBytes(input.plan.goal, ...input.plan.tasks.map(({ description }) => description)) }),
      execute: async (input: { plan: CoWorkPlan }, signal: AbortSignal) => {
        signal.throwIfAborted();
        assertRequiredParticipant(await client.coWorkStatus(input.plan.coWorkId), options.selfId);
        signal.throwIfAborted();
        const plan = CoWorkPlanSchema.parse({
          ...input.plan,
          goal: shareGuard.protect(input.plan.goal),
          tasks: input.plan.tasks.map((task) => ({ ...task, description: shareGuard.protect(task.description) })),
        });
        return client.coWorkAction({ type: "cowork-plan", plan });
      },
    },
    {
      ...common,
      name: "CoWorkReady",
      description: "Accept the exact current plan and atomically record readiness, even while other participants are still reviewing it",
      inputSchema: TokenInput,
      execute: async (input: z.infer<typeof TokenInput>, signal: AbortSignal) => {
        signal.throwIfAborted();
        let state = await assertCurrentToken(client, input);
        signal.throwIfAborted();
        assertRequiredParticipant(state, options.selfId);
        if (!state.planAcceptedParticipantIds.includes(options.selfId)) {
          state = await client.coWorkAction({ type: "cowork-plan-accept", ...input });
        }
        if (state.readyParticipantIds.includes(options.selfId) || state.phase === "running") return state;
        signal.throwIfAborted();
        return client.coWorkAction({ type: "cowork-ready", ...input });
      },
    },
    {
      ...common,
      ...onceOnlyApproval,
      name: "CoWorkProgress",
      description: "Send a bounded progress fact to an active or accepted co-work participant",
      inputSchema: ProgressInput,
      permissionInput: (input: z.infer<typeof ProgressInput>) => ({ coWorkId: input.coWorkId, target: input.target, sharedBytes: sharedBytes(input.detail) }),
      execute: async (input: z.infer<typeof ProgressInput>, signal: AbortSignal) => {
        signal.throwIfAborted();
        const recipientId = await assertSendTarget(client, input.target, input.coWorkId);
        signal.throwIfAborted();
        return client.sendChat(recipientId, `[co-work ${input.coWorkId} progress] ${shareGuard.protect(input.detail)}`);
      },
    },
    {
      ...common,
      ...onceOnlyApproval,
      name: "CoWorkComplete",
      description: "Report local co-work completion with nonempty verification evidence or an explicit waiver",
      inputSchema: CompleteInput,
      permissionInput: (input: z.infer<typeof CompleteInput>) => ({ coWorkId: input.coWorkId, epoch: input.epoch, planHash: input.planHash, passed: input.passed, sharedBytes: sharedBytes(input.detail) }),
      execute: async (input: z.infer<typeof CompleteInput>, signal: AbortSignal) => {
        signal.throwIfAborted();
        const state = await assertCurrentToken(client, input);
        signal.throwIfAborted();
        assertRequiredParticipant(state, options.selfId);
        if (state.phase !== "running" || !state.acceptedParticipantIds.includes(options.selfId) || !state.readyParticipantIds.includes(options.selfId)) {
          throw new Error("A required participant must be accepted, ready, and running before reporting completion");
        }
        return client.coWorkAction({ type: "cowork-complete", ...input, detail: shareGuard.protect(input.detail) });
      },
    },
    {
      ...common,
      ...onceOnlyApproval,
      name: "CoWorkIntegrate",
      description: "Integration owner only: inspect all completion assertions, run cross-project verification, then finalize with nonempty evidence; all peers receive END or FAIL",
      inputSchema: IntegrateInput,
      permissionInput: (input: z.infer<typeof IntegrateInput>) => ({ coWorkId: input.coWorkId, epoch: input.epoch, planHash: input.planHash, passed: input.passed, sharedBytes: sharedBytes(input.evidence) }),
      execute: async (input: z.infer<typeof IntegrateInput>, signal: AbortSignal) => {
        signal.throwIfAborted();
        const state = await assertCurrentToken(client, input);
        signal.throwIfAborted();
        assertRequiredParticipant(state, options.selfId);
        if (state.integrationOwnerId !== options.selfId) throw new Error("Only the broker-designated integration owner can finalize integration");
        if (state.phase !== "verifying") throw new Error("Co-work is not ready for integration verification");
        return client.integrateCoWork({ ...input, evidence: shareGuard.protect(input.evidence) });
      },
    },
  ] as ToolDefinition<unknown>[];
}
