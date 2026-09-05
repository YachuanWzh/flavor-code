/**
 * RSI control service — task P0-03c (rsi.md 11.3/11.4, E2/E6).
 *
 * The single authority that may mutate RSI durable state. Design rules:
 * - Callers authenticate with minted role tokens (SHA-256 at rest, in-memory
 *   map here; the trusted host mints one identity per client). Candidates get
 *   tokens with *zero* mutating authority — a promotion request from a
 *   candidate token is refused before any body is touched (hard rule 7).
 * - Every mutating request is dispatched through the event-ledger primitives
 *   (budget ledger / append-only control log), so decisions are crash-safe
 *   and idempotency keys replay original results rather than double-acting.
 * - The pause switch lives in the CAS snapshot: while paused, mutations are
 *   rejected with code `paused` except un-pausing and reconciliation reads.
 * - Promotion/rollback *machines* land with P0-08; this service already
 *   enforces who may ever ask them (executor answers `unsupported`).
 */

import { createHash, randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";

import { z } from "zod";

import { artifactManifestHash, freezeArtifact } from "./artifact.js";
import { RsiBudgetLedger, RsiIdempotencyConflictError } from "./budget.js";
import {
  RSI_CONTROL_REQUEST_BODY_SCHEMAS,
  RsiControlRequestSchema,
  type RsiControlErrorBody,
  type RsiControlRequest,
  type RsiControlResponse,
} from "./control-protocol.js";
import { RsiControlStore, RsiRevisionConflictError } from "./store.js";
import type { RsiControlRequestKind, RsiRequestIdentity } from "./types.js";
import { checkRequestAuthority } from "./policy.js";

export interface RsiControlServiceOptions {
  store: RsiControlStore;
  budget: RsiBudgetLedger;
  /** Protected artifact store root (parent dir of `artifacts/`). */
  artifactStore: string;
}

const KINDS_ALLOWED_WHILE_PAUSED = new Set<RsiControlRequestKind>(["pause", "reconcile.report", "reconcile.close"]);

export class RsiControlService {
  readonly #store: RsiControlStore;
  readonly #budget: RsiBudgetLedger;
  readonly #artifactStore: string;
  readonly #tokens = new Map<string, RsiRequestIdentity>();

  constructor(options: RsiControlServiceOptions) {
    this.#store = options.store;
    this.#budget = options.budget;
    this.#artifactStore = options.artifactStore;
  }

  /** Mint an opaque bearer token bound to a verified identity. */
  mintToken(identity: RsiRequestIdentity): string {
    const token = randomBytes(24).toString("hex");
    this.#tokens.set(hashToken(token), identity);
    return token;
  }

  /** Authenticate a raw transport request; public for embedding gateways. */
  identify(token: string): RsiRequestIdentity | undefined {
    return this.#tokens.get(hashToken(token));
  }

  async handle(raw: unknown): Promise<RsiControlResponse> {
    const parsed = RsiControlRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return failure(requestIdOf(raw), "invalid_request", firstIssue(parsed.error));
    }
    const request = parsed.data;
    const identity = this.identify(request.token);
    if (identity === undefined) {
      return failure(request.requestId, "unauthorized", "unknown or revoked control token");
    }
    const authority = checkRequestAuthority(identity, request.kind);
    if (!authority.ok) {
      return failure(request.requestId, "forbidden", authority.reason);
    }
    const bodySchema = RSI_CONTROL_REQUEST_BODY_SCHEMAS[request.kind];
    const body = bodySchema.safeParse(request.body);
    if (!body.success) {
      return failure(request.requestId, "invalid_request", firstIssue(body.error));
    }
    try {
      if (!(await this.#isPaused()) || KINDS_ALLOWED_WHILE_PAUSED.has(request.kind)) {
        return ok(request.requestId, await this.#dispatch(request, identity, body.data));
      }
      return failure(request.requestId, "paused", "RSI control mutations are paused");
    } catch (error) {
      return failure(request.requestId, classify(error), errorMessage(error));
    }
  }

  async #isPaused(): Promise<boolean> {
    const snapshot = await this.#store.readState();
    return snapshot?.data["paused"] === true;
  }

  async #dispatch(request: RsiControlRequest, identity: RsiRequestIdentity, body: any): Promise<unknown> {
    const key = request.idempotencyKey as string; // enforced by the envelope for all mutating kinds
    switch (request.kind) {
      case "budget.reserve":
        return this.#budget.reserve({ jobId: body.jobId, amount: body.amount, idempotencyKey: key });
      case "budget.settle":
        return this.#budget.settle({ jobId: body.jobId, ...(body.consumed === undefined || body.consumed === null ? {} : { consumed: body.consumed }), idempotencyKey: key });
      case "trial.report": {
        const terminalEvent = await this.#store.appendEvent({
          type: "trial.reported",
          idempotencyKey: `${key}:terminal`,
          payload: { terminal: body.terminal, reporterClientId: identity.clientId },
        });
        const settlement = await this.#budget.settle({
          jobId: body.terminal.jobId,
          ...(body.consumption === null ? {} : { consumed: body.consumption }),
          idempotencyKey: `${key}:settle`,
        });
        return { recorded: !terminalEvent.duplicate, settlement };
      }
      case "artifact.freeze": {
        const artifactHash = artifactManifestHash(body.manifest);
        await mkdir(this.#artifactStore, { recursive: true, mode: 0o700 });
        const frozen = await freezeArtifact({ store: this.#artifactStore, root: body.root, manifest: body.manifest });
        if (frozen.artifactHash !== artifactHash) {
          throw new Error("Freeze produced a hash that differs from the manifest digest");
        }
        await this.#store.appendEvent({
          type: "artifact.frozen",
          idempotencyKey: key,
          payload: { artifactHash, stateSchemaVersion: body.manifest.stateSchemaVersion },
        });
        return { artifactHash };
      }
      case "candidate.propose": {
        const appended = await this.#store.appendEvent({ type: "candidate.proposed", idempotencyKey: key, payload: { candidate: body } });
        return { candidateId: body.candidateId, duplicate: appended.duplicate };
      }
      case "eval.register": {
        const appended = await this.#store.appendEvent({ type: "eval.completed", idempotencyKey: key, payload: { report: body } });
        return { reportId: body.reportId, duplicate: appended.duplicate };
      }
      case "pause": {
        const next = await this.#store.transact(async (tx) => {
          const current = await tx.readState();
          const revision = current?.revision ?? 0;
          const data = { ...(current?.data ?? {}), paused: body.paused };
          return tx.compareAndSetState({ expectedRevision: revision, data });
        });
        return { paused: next.data["paused"] === true, revision: next.revision };
      }
      case "reconcile.report": {
        const [summary, events] = await Promise.all([this.#budget.summary(), this.#store.listEvents()]);
        return {
          summary,
          outcomeFlushes: events.filter((event) => event.type === "tool_outcomes").length,
          terminalsReported: events.filter((event) => event.type === "trial.reported").length,
        };
      }
      case "reconcile.close":
        return this.#budget.settle({ jobId: body.jobId, consumed: body.consumed, idempotencyKey: key });
      case "promotion.prepare":
      case "promotion.commit":
      case "rollback.start":
      case "rollback.complete":
        throw new RsiUnsupportedError(`${request.kind} requires the release machinery (P0-08); authority was enforced before this point`);
    }
  }
}

class RsiUnsupportedError extends Error {}

function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function requestIdOf(raw: unknown): string {
  return typeof raw === "object" && raw !== null && typeof (raw as { requestId?: unknown }).requestId === "string"
    ? (raw as { requestId: string }).requestId
    : "unknown";
}

function firstIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  return issue === undefined ? "invalid control request" : `${issue.path.join(".")}: ${issue.message}`;
}

function classify(error: unknown): RsiControlErrorBody["code"] {
  if (error instanceof RsiIdempotencyConflictError || error instanceof RsiRevisionConflictError) return "conflict";
  if (error instanceof RsiUnsupportedError) return "unsupported";
  if (error instanceof z.ZodError) return "invalid_request";
  if (error instanceof Error && /No outstanding|not found|missing/i.test(error.message)) return "not_found";
  return "internal";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function ok(requestId: string, result: unknown): RsiControlResponse {
  return { schemaVersion: 1, requestId, ok: true, result };
}

function failure(requestId: string, code: RsiControlErrorBody["code"], message: string): RsiControlResponse {
  return { schemaVersion: 1, requestId, ok: false, error: { code, message } };
}
