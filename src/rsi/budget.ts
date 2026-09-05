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
 *   keeps the whole reservation charged (conservative accounting).
 * - Idempotency: the same `idempotencyKey` returns the original decision and
 *   never reserves (or bills) twice — including refusals.
 * - The cap is a fixed daily window keyed by `YYYY-MM-DD`; outstanding
 *   reservations always count against the limit regardless of their day, so
 *   rollover cannot launder a debt.
 * - Check-then-append runs under the ledger lock, so two clients racing for
 *   the same remaining budget cannot both be granted (no oversell).
 */

import { z } from "zod";

import type { RsiControlStore, RsiControlTransaction } from "./store.js";

const ReservePayloadSchema = z.object({
  jobId: z.string().min(1),
  amount: z.number().int().positive(),
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  granted: z.boolean(),
  reason: z.string().nullable(),
}).strict();

const SettlePayloadSchema = z.object({
  jobId: z.string().min(1),
  /** null = usage unknown after a crash; the full reservation stays charged. */
  consumed: z.number().int().nonnegative().nullable(),
}).strict();

export type BudgetReservePayload = z.infer<typeof ReservePayloadSchema>;
export type BudgetSettlePayload = z.infer<typeof SettlePayloadSchema>;

export interface BudgetReserveResult {
  granted: boolean;
  jobId: string;
  amount: number;
  /** True when an earlier request with this idempotencyKey decided the outcome. */
  duplicate: boolean;
  reason: string | null;
}

export interface BudgetSummary {
  limit: number;
  day: string;
  /** Reserved-and-not-yet-settled allowances (crash-unknown usage stays here). */
  outstanding: number;
  /** Settled consumption attributed to `day`. */
  dayConsumed: number;
  /** Settled consumption across all days. */
  totalConsumed: number;
  unsettledJobs: string[];
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
      const prior = await findKey(tx, input.idempotencyKey);
      if (prior !== undefined) {
        const payload = ReservePayloadSchema.parse(prior.payload);
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
      if (existing !== undefined && existing.open) {
        throw new Error(`Job ${input.jobId} already holds an open reservation; settle it before reserving again`);
      }
      const outstandingOther = sumOutstanding(state, input.jobId);
      const dayConsumed = state.dayConsumed.get(day) ?? 0;
      if (outstandingOther + dayConsumed + input.amount > this.#limit) {
        await tx.appendEvent({
          type: "budget.reserved",
          idempotencyKey: input.idempotencyKey,
          payload: { jobId: input.jobId, amount: input.amount, day, granted: false, reason: "exceeds_daily_limit" } satisfies BudgetReservePayload,
        });
        return { granted: false, jobId: input.jobId, amount: input.amount, duplicate: false, reason: "exceeds_daily_limit" };
      }
      await tx.appendEvent({
        type: "budget.reserved",
        idempotencyKey: input.idempotencyKey,
        payload: { jobId: input.jobId, amount: input.amount, day, granted: true, reason: null } satisfies BudgetReservePayload,
      });
      return { granted: true, jobId: input.jobId, amount: input.amount, duplicate: false, reason: null };
    });
  }

  /**
   * Settle a finished job. Known usage releases the unused reservation;
   * omitting `consumed` (crash / unconfirmed proxy accounting) keeps the full
   * amount charged until the reconciliation owner decides otherwise.
   */
  async settle(input: { jobId: string; consumed?: number }): Promise<{ released: number; consumed: number }> {
    if (input.consumed !== undefined && (!Number.isSafeInteger(input.consumed) || input.consumed < 0)) {
      throw new Error("consumed must be a non-negative integer when provided");
    }
    return this.#store.transact(async (tx) => {
      const state = await deriveState(tx);
      const reservation = state.reservations.get(input.jobId);
      if (reservation === undefined || !reservation.open) {
        throw new Error(`No outstanding budget reservation for job ${input.jobId}`);
      }
      const consumed = input.consumed ?? reservation.amount;
      if (consumed > reservation.amount) {
        throw new Error(`Settled usage ${consumed} exceeds reserved allowance ${reservation.amount} for job ${input.jobId}`);
      }
      await tx.appendEvent({
        type: "budget.settled",
        payload: { jobId: input.jobId, consumed: input.consumed ?? null } satisfies BudgetSettlePayload,
      });
      return { released: reservation.amount - consumed, consumed };
    });
  }

  /** Current ledger view derived by replaying the durable event log. */
  async summary(): Promise<BudgetSummary> {
    return this.#store.transact(async (tx) => {
      const state = await deriveState(tx);
      const day = this.#day();
      let outstanding = 0;
      const unsettledJobs: string[] = [];
      for (const [jobId, reservation] of state.reservations) {
        if (reservation.open) {
          outstanding += reservation.amount;
          unsettledJobs.push(jobId);
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
      };
    });
  }

  #day(): string {
    return this.#now().toISOString().slice(0, 10);
  }
}

async function findKey(tx: RsiControlTransaction, idempotencyKey: string) {
  const events = await tx.listEvents();
  return events.find((record) => record.type === "budget.reserved" && record.idempotencyKey === idempotencyKey);
}

interface DerivedBudgetState {
  reservations: Map<string, { amount: number; day: string; open: boolean }>;
  dayConsumed: Map<string, number>;
}

/** Replay the event log; must run inside a store transaction (lock held). */
async function deriveState(tx: RsiControlTransaction): Promise<DerivedBudgetState> {
  const events = await tx.listEvents();
  const reservations = new Map<string, { amount: number; day: string; open: boolean }>();
  const dayConsumed = new Map<string, number>();
  for (const record of events) {
    if (record.type === "budget.reserved") {
      const payload = ReservePayloadSchema.parse(record.payload);
      if (payload.granted) {
        const existing = reservations.get(payload.jobId);
        if (existing !== undefined && existing.open) {
          throw new Error(`Job ${payload.jobId} already holds an open reservation; settle it before reserving again`);
        }
        reservations.set(payload.jobId, { amount: payload.amount, day: payload.day, open: true });
      }
    } else if (record.type === "budget.settled") {
      const payload = SettlePayloadSchema.parse(record.payload);
      const reservation = reservations.get(payload.jobId);
      if (reservation === undefined || !reservation.open) {
        throw new Error(`budget.settled without an open reservation for job ${payload.jobId}`);
      }
      reservation.open = false;
      const consumed = payload.consumed ?? reservation.amount;
      dayConsumed.set(reservation.day, (dayConsumed.get(reservation.day) ?? 0) + consumed);
    }
  }
  return { reservations, dayConsumed };
}

function sumOutstanding(
  state: { reservations: Map<string, { amount: number; day: string; open: boolean }> },
  excludeJobId: string,
): number {
  let total = 0;
  for (const [jobId, reservation] of state.reservations) {
    if (reservation.open && jobId !== excludeJobId) total += reservation.amount;
  }
  return total;
}
