/**
 * RSI control protocol — task P0-03c (rsi.md 11.3/11.4, E2/E6).
 *
 * Declarative wire contract between control clients and the control service.
 * Two rules shape it:
 * - Every mutating request must carry an `idempotencyKey` derived from the
 *   request identity, so a crash-retry replays the original decision instead
 *   of dispatching twice (the only read-only kind is `reconcile.report`).
 * - Bodies are strictly typed per kind; unknown fields never reach an
 *   executor. Authority (role checks) lives in the service, not here.
 */

import { z } from "zod";

import { ArtifactManifestSchema } from "./artifact.js";
import { RSI_CONTROL_REQUEST_KINDS, RsiCandidateSchema, RsiEvalReportSchema, RsiTrialTerminalSchema } from "./types.js";

export const RSI_CONTROL_PROTOCOL_VERSION = 1 as const;

/** Closed error taxonomy the service may return; clients switch on `code`. */
export const RSI_CONTROL_ERROR_CODES = [
  "unauthorized",
  "forbidden",
  "invalid_request",
  "conflict",
  "paused",
  "not_found",
  "unsupported",
  "internal",
] as const;
export type RsiControlErrorCode = (typeof RSI_CONTROL_ERROR_CODES)[number];

/** Kinds that never need an idempotency key (pure reads). */
const READ_ONLY_KINDS: readonly string[] = ["reconcile.report"];

const IntNonNeg = z.number().int().nonnegative();

export const RSI_CONTROL_REQUEST_BODY_SCHEMAS: Record<(typeof RSI_CONTROL_REQUEST_KINDS)[number], z.ZodTypeAny> = {
  "budget.reserve": z.object({ jobId: z.string().min(1), amount: z.number().int().positive() }).strict(),
  "budget.settle": z.object({ jobId: z.string().min(1), consumed: IntNonNeg.nullable().optional() }).strict(),
  "trial.report": z
    .object({
      terminal: RsiTrialTerminalSchema,
      /** Trusted billing translation of the terminal usage; null = unknown. */
      consumption: IntNonNeg.nullable(),
    })
    .strict(),
  "artifact.freeze": z.object({ root: z.string().min(1), manifest: ArtifactManifestSchema }).strict(),
  "candidate.propose": RsiCandidateSchema,
  "eval.register": RsiEvalReportSchema,
  "promotion.prepare": z.object({ candidateId: z.string().min(1) }).strict(),
  "promotion.commit": z.object({ candidateId: z.string().min(1), reportId: z.string().min(1) }).strict(),
  "rollback.start": z.object({ fromReleaseId: z.string().min(1), toReleaseId: z.string().min(1) }).strict(),
  "rollback.complete": z.object({ rollbackId: z.string().min(1) }).strict(),
  "pause": z.object({ paused: z.boolean() }).strict(),
  "reconcile.report": z.object({}).strict(),
  "reconcile.close": z.object({ jobId: z.string().min(1), consumed: IntNonNeg }).strict(),
};

export const RsiControlRequestSchema = z
  .object({
    schemaVersion: z.literal(RSI_CONTROL_PROTOCOL_VERSION),
    requestId: z.string().min(1),
    /** Transport credential; the service maps it to a RsiRequestIdentity. */
    token: z.string().min(16),
    kind: z.enum(RSI_CONTROL_REQUEST_KINDS),
    idempotencyKey: z.string().min(1).optional(),
    body: z.unknown(),
  })
  .strict()
  .superRefine((request, ctx) => {
    if (!READ_ONLY_KINDS.includes(request.kind) && request.idempotencyKey === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["idempotencyKey"],
        message: `mutating request "${request.kind}" must carry an idempotencyKey derived from its request identity`,
      });
    }
  });
export type RsiControlRequest = z.infer<typeof RsiControlRequestSchema>;

export const RsiControlErrorSchema = z
  .object({ code: z.enum(RSI_CONTROL_ERROR_CODES), message: z.string().min(1) })
  .strict();
export type RsiControlErrorBody = z.infer<typeof RsiControlErrorSchema>;

export const RsiControlResponseSchema = z.discriminatedUnion("ok", [
  z.object({ schemaVersion: z.literal(RSI_CONTROL_PROTOCOL_VERSION), requestId: z.string(), ok: z.literal(true), result: z.unknown() }).strict(),
  z.object({ schemaVersion: z.literal(RSI_CONTROL_PROTOCOL_VERSION), requestId: z.string(), ok: z.literal(false), error: RsiControlErrorSchema }).strict(),
]);
export type RsiControlResponse = z.infer<typeof RsiControlResponseSchema>;

/** Error thrown by `RsiControlClient` for `ok:false` responses. */
export class RsiControlError extends Error {
  constructor(readonly code: RsiControlErrorCode, message: string) {
    super(message);
    this.name = "RsiControlError";
  }
}
