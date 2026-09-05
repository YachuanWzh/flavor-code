/**
 * RSI experiment budget ledger — task P0-03b (rsi.md sections 5.4/11.4, E6).
 *
 * Built on top of the protected control store: reservations and settlements
 * are durable `budget.reserved` / `budget.settled` events, so a crash can
 * never "reset the meter". Authority is the event log; queries replay it.
 *
 * Semantics fixed by the RSI contract:
 * - Reserve-before-spend: a job may only start after its full worst-case
 *   allowance (input + max output + grader share) is atomically reserved.
 * - Settlement releases only the unused remainder; an *unknown* final usage
 *   moves the reservation to a pending-reconciliation hold: the full amount
 *   stays outstanding (blocking new spend, even across day rollover) until a
 *   later settlement reports the confirmed consumption.
 * - Idempotency: the same `idempotencyKey` returns the original decision and
 *   never reserves (or bills) twice — including refusals and settlements
 *   (a crash-retry of one `settle` replays its logical result). The ledger's
 *   dedup spans *all* event types, so a key already used by another request
 *   kind, or reused with different content, is a conflict, not a grant.
 * - The cap is a fixed daily window keyed by `YYYY-MM-DD`; outstanding
 *   reservations always count against the limit regardless of their day, so
 *   rollover cannot launder a debt.
 * - Check-then-append runs under the ledger lock, so two clients racing for
 *   the same remaining budget cannot both be granted (no oversell).
 */

import { z } from "zod";

import type { RsiControlEventRecord, RsiControlStore, RsiControlTransaction } from "./store.js";

const ReservePayloadSchema = z.object({
  jobId: z.string().min(1),
  amount: z.number().int().positive(),
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  granted: z.boolean(),
  reason: z.string().nullable(),
}).strict();

const SettlePayloadSchema = z.object({
  jobId: z.string().min(1),
  /** null = usage unknown after a crash; the reservation enters the hold. */
  consumed: z.number().int().nonnegative().nullable(),
}).strict();

export type BudgetReservePayload = z.infer<typeof ReservePayloadSchema>;
export type BudgetSettlePayload = z.infer<typeof SettlePayloadSchema>;

/** Thrown when an idempotency key collides with a different request. */
export class RsiIdempotencyConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RsiIdempotencyConflictError";
  }
}

export interface BudgetReserveResult {
  granted: boolean;
  jobId: string;
  amount: number;
  /** True when an earlier request with this idempotencyKey decided the outcome. */
  duplicate: boolean;
  reason: string | null;
}

export type BudgetSettleStatus = "settled" | "awaiting_reconciliation";

export interface BudgetSettleResult {
  status: BudgetSettleStatus;
  /** Allowance released back to the cap by this call. */
  released: number;
  /** Amount still charged/held after this call. */
  consumed: number;
}

export interface BudgetSummary {
  limit: number;
  day: string;
  /** Reserved-and-not-yet-settled allowances (pending holds stay here). */
  outstanding: number;
  /** Settled consumption attributed to `day`. */
  dayConsumed: number;
  /** Settled consumption across all days. */
  totalConsumed: number;
  /** Jobs whose reservation is not closed yet (open or pending reconciliation). */
  unsettledJobs: string[];
  /** Subset of `unsettledJobs` held conservatively for unknown usage. */
  reconciliationJobs: string[];
}

export interface RsiBudgetLedgerOptions {
  store: RsiControlStore;
  /** Per-day experiment token cap (config `dailyMaxTokens`). */
  limit: number;
  now?(): Date;
}

export class RsiBudgetLedger {
  readonly #store: RsiControlStore;
  readonly #limit: number;
  readonly #now: () => Date;

  constructor(options: RsiBudgetLedgerOptions) {
    if (!Number.isSafeInteger(options.limit) || options.limit <= 0) {
      throw new Error("budget limit must be a positive integer");
    }
    this.#store = options.store;
    this.#limit = options.limit;
    this.#now = options.now ?? (() => new Date());
  }

  /**
   * Atomically reserve `amount` tokens for a job's worst-case allowance.
   * `idempotencyKey` must be derived from the trusted call identity; retries
   * of the same request return the same decision without re-charging.
   */
  async reserve(input: { jobId: string; amount: number; idempotencyKey: string }): Promise<BudgetReserveResult> {
    if (input.jobId.length === 0) throw new Error("jobId must be non-empty");
    if (!Number.isSafeInteger(input.amount) || input.amount <= 0) {
      throw new Error("reserve amount must be a positive integer");
    }
    return this.#store.transact(async (tx) => {
      const prior = await findKeyRecord(tx, input.idempotencyKey);
      if (prior !== undefined) {
        if (prior.type !== "budget.reserved") {
          throw new RsiIdempotencyConflictError(
            `Idempotency key ${JSON.stringify(input.idempotencyKey)} was already used by a ${prior.type} event; derive keys from the request identity`,
          );
        }
        const payload = ReservePayloadSchema.parse(prior.payload);
        if (payload.jobId !== input.jobId || payload.amount !== input.amount) {
          throw new RsiIdempotencyConflictError(
            `Idempotency key ${JSON.stringify(input.idempotencyKey)} was already used by a different reservation (${payload.jobId}/${payload.amount})`,
          );
        }
        return {
          granted: payload.granted,
          jobId: payload.jobId,
          amount: payload.amount,
          duplicate: true,
          reason: payload.reason,
        };
      }
      const day = this.#day();
      const state = await deriveState(tx);
      const existing = state.reservations.get(input.jobId);
      if (existing !== undefined && existing.status !== "settled") {
        throw new Error(`Job ${input.jobId} already holds an outstanding reservation; settle it before reserving again`);
      }
      const outstandingOther = sumOutstanding(state, input.jobId);
      const dayConsumed = state.dayConsumed.get(day) ?? 0;
      const granted = outstandingOther + dayConsumed + input.amount <= this.#limit;
      const payload = {
        jobId: input.jobId,
        amount: input.amount,
        day,
        granted,
        reason: granted ? null : "exceeds_daily_limit",
      } satisfies BudgetReservePayload;
      const appended = await tx.appendEvent({ type: "budget.reserved", idempotencyKey: input.idempotencyKey, payload });
      if (appended.duplicate) {
        // The store dedupes by key across all events; if it skipped our
        // append, the earlier record was not the reservation we intended.
        throw new RsiIdempotencyConflictError(
          `Budget reservation append for key ${JSON.stringify(input.idempotencyKey)} was deduplicated against an unrelated event`,
        );
      }
      return { granted, jobId: input.jobId, amount: input.amount, duplicate: false, reason: payload.reason };
    });
  }

  /**
   * Settle a finished job. Known usage closes the reservation and releases
   * the unused remainder; omitting `consumed` (crash / unconfirmed proxy
   * accounting) puts the reservation into a pending-reconciliation hold that
   * keeps the full amount outstanding until a later settle reports the real
   * usage. Repeated unknown settles on a held job are idempotent no-ops.
   */
  async settle(input: {
    jobId: string;
    consumed?: number;
    /** Trusted call identity; a crash-retry of the same settle replays it. */
    idempotencyKey?: string;
  }): Promise<BudgetSettleResult> {
    if (input.consumed !== undefined && (!Number.isSafeInteger(input.consumed) || input.consumed < 0)) {
      throw new Error("consumed must be a non-negative integer when provided");
    }
    return this.#store.transact(async (tx) => {
      const state = await deriveState(tx);
      if (input.idempotencyKey !== undefined) {
        const prior = await findKeyRecord(tx, input.idempotencyKey);
        if (prior !== undefined) {
          const replay = settleReplayFrom(prior, input, state);
          if (replay !== undefined) return replay;
        }
      }
      const reservation = state.reservations.get(input.jobId);
      if (reservation === undefined || reservation.status === "settled") {
        throw new Error(`No outstanding budget reservation for job ${input.jobId}`);
      }
      if (input.consumed !== undefined && input.consumed > reservation.amount) {
        throw new Error(`Settled usage ${input.consumed} exceeds reserved allowance ${reservation.amount} for job ${input.jobId}`);
      }
      const payload: BudgetSettlePayload = { jobId: input.jobId, consumed: input.consumed ?? null };
      const appended = await tx.appendEvent({
        type: "budget.settled",
        ...(input.idempotencyKey !== undefined ? { idempotencyKey: input.idempotencyKey } : {}),
        payload,
      });
      if (appended.duplicate) {
        throw new RsiIdempotencyConflictError(
          `Settlement append for key ${JSON.stringify(input.idempotencyKey)} was deduplicated against an unrelated event`,
        );
      }
      if (input.consumed === undefined) {
        return { status: "awaiting_reconciliation", released: 0, consumed: reservation.amount };
      }
      return { status: "settled", released: reservation.amount - input.consumed, consumed: input.consumed };
    });
  }

  /** Current ledger view derived by replaying the durable event log. */
  async summary(): Promise<BudgetSummary> {
    return this.#store.transact(async (tx) => {
      const state = await deriveState(tx);
      const day = this.#day();
      let outstanding = 0;
      const unsettledJobs: string[] = [];
      const reconciliationJobs: string[] = [];
      for (const [jobId, reservation] of state.reservations) {
        if (reservation.status !== "settled") {
          outstanding += reservation.amount;
          unsettledJobs.push(jobId);
          if (reservation.status === "disputed") reconciliationJobs.push(jobId);
        }
      }
      let totalConsumed = 0;
      for (const value of state.dayConsumed.values()) totalConsumed += value;
      return {
        limit: this.#limit,
        day,
        outstanding,
        dayConsumed: state.dayConsumed.get(day) ?? 0,
        totalConsumed,
        unsettledJobs,
        reconciliationJobs,
      };
    });
  }

  #day(): string {
    return this.#now().toISOString().slice(0, 10);
  }
}

/**
 * Locate any event carrying this idempotencyKey. Must mirror the store's
 * dedup scope (all event types), otherwise a key collision with a foreign
 * event would make `appendEvent` skip the write while `reserve` still
 * reported a grant.
 */
/**
 * Resolve a settle retry from the durable event that already carries the
 * key. Returns the original logical decision; any key misuse is a conflict.
 */
function settleReplayFrom(
  prior: RsiControlEventRecord,
  input: { jobId: string; consumed?: number; idempotencyKey?: string },
  state: DerivedBudgetState,
): BudgetSettleResult | undefined {
  if (prior.type !== "budget.settled") {
    throw new RsiIdempotencyConflictError(
      `Idempotency key ${JSON.stringify(input.idempotencyKey)} was already used by a ${prior.type} event; derive keys from the request identity`,
    );
  }
  const payload = SettlePayloadSchema.parse(prior.payload);
  if (payload.jobId !== input.jobId || payload.consumed !== (input.consumed ?? null)) {
    throw new RsiIdempotencyConflictError(
      `Idempotency key ${JSON.stringify(input.idempotencyKey)} was already used by a different settlement (${payload.jobId}/${payload.consumed})`,
    );
  }
  const reservation = state.reservations.get(payload.jobId);
  if (reservation === undefined) {
    throw new Error(`Durable settlement references unknown job ${payload.jobId}`);
  }
  if (payload.consumed === null) {
    return { status: "awaiting_reconciliation", released: 0, consumed: reservation.amount };
  }
  return { status: "settled", released: reservation.amount - payload.consumed, consumed: payload.consumed };
}

async function findKeyRecord(tx: RsiControlTransaction, idempotencyKey: string) {
  const events = await tx.listEvents();
  return events.find((record) => record.idempotencyKey === idempotencyKey);
}

type ReservationStatus = "open" | "disputed" | "settled";

interface DerivedBudgetState {
  reservations: Map<string, { amount: number; day: string; status: ReservationStatus }>;
  dayConsumed: Map<string, number>;
}

/** Replay the event log; must run inside a store transaction (lock held). */
async function deriveState(tx: RsiControlTransaction): Promise<DerivedBudgetState> {
  const events = await tx.listEvents();
  const reservations = new Map<string, { amount: number; day: string; status: ReservationStatus }>();
  const dayConsumed = new Map<string, number>();
  for (const record of events) {
    if (record.type === "budget.reserved") {
      const payload = ReservePayloadSchema.parse(record.payload);
      if (payload.granted) {
        const existing = reservations.get(payload.jobId);
        if (existing !== undefined && existing.status !== "settled") {
          throw new Error(`Job ${payload.jobId} already holds an outstanding reservation; settle it before reserving again`);
        }
        reservations.set(payload.jobId, { amount: payload.amount, day: payload.day, status: "open" });
      }
    } else if (record.type === "budget.settled") {
      const payload = SettlePayloadSchema.parse(record.payload);
      const reservation = reservations.get(payload.jobId);
      if (reservation === undefined || reservation.status === "settled") {
        throw new Error(`budget.settled without an outstanding reservation for job ${payload.jobId}`);
      }
      if (payload.consumed === null) {
        // Unknown usage: conservative hold. Nothing is billed to any day and
        // the full amount stays outstanding until a settle reports real usage.
        reservation.status = "disputed";
        continue;
      }
      if (payload.consumed > reservation.amount) {
        throw new Error(`budget.settled usage ${payload.consumed} exceeds reserved allowance ${reservation.amount} for job ${payload.jobId}`);
      }
      reservation.status = "settled";
      dayConsumed.set(reservation.day, (dayConsumed.get(reservation.day) ?? 0) + payload.consumed);
    }
  }
  return { reservations, dayConsumed };
}

function sumOutstanding(
  state: { reservations: Map<string, { amount: number; day: string; status: ReservationStatus }> },
  excludeJobId: string,
): number {
  let total = 0;
  for (const [jobId, reservation] of state.reservations) {
    if (reservation.status !== "settled" && jobId !== excludeJobId) total += reservation.amount;
  }
  return total;
}
