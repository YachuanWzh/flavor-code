/**
 * RSI control client — task P0-03c (rsi.md 11.3).
 *
 * Thin, strict envelope builder over an injected transport (loopback in
 * tests; a local IPC socket can be plugged in without touching callers). The
 * client validates its own outgoing bodies against the protocol schema, so a
 * caller learns about a malformed request locally, and translates every
 * `ok:false` response into a typed `RsiControlError`.
 */

import { randomUUID } from "node:crypto";

import {
  RSI_CONTROL_REQUEST_BODY_SCHEMAS,
  RsiControlRequestSchema,
  RsiControlError,
  RsiControlResponseSchema,
  type RsiControlErrorCode,
} from "./control-protocol.js";
import type { RsiControlRequestKind } from "./types.js";

/** Sends a protocol request and returns the raw (untrusted) response. */
export type RsiControlTransport = (request: unknown) => Promise<unknown>;

export interface RsiControlClientOptions {
  transport: RsiControlTransport;
  /** Bearer token minted by the control service for this client's identity. */
  token: string;
  requestId?(): string;
}

export class RsiControlClient {
  readonly #transport: RsiControlTransport;
  readonly #token: string;
  readonly #requestId: () => string;

  constructor(options: RsiControlClientOptions) {
    this.#transport = options.transport;
    this.#token = options.token;
    this.#requestId = options.requestId ?? (() => randomUUID());
  }

  /**
   * Dispatch a kind-typed request. `idempotencyKey` is required for every
   * mutating kind (the schema enforces it); derive it from the caller's own
   * request identity, never from candidate-controlled text.
   */
  async call<K extends RsiControlRequestKind>(kind: K, body: unknown, options?: { idempotencyKey?: string }): Promise<unknown> {
    const parsedBody = RSI_CONTROL_REQUEST_BODY_SCHEMAS[kind].safeParse(body);
    if (!parsedBody.success) {
      throw new RsiControlError("invalid_request", `local body validation failed for "${kind}": ${parsedBody.error.issues[0]?.message ?? "invalid"}`);
    }
    const raw = {
      schemaVersion: 1 as const,
      requestId: this.#requestId(),
      token: this.#token,
      kind,
      ...(options?.idempotencyKey === undefined ? {} : { idempotencyKey: options.idempotencyKey }),
      body,
    };
    const envelope = RsiControlRequestSchema.safeParse(raw);
    if (!envelope.success) {
      throw new RsiControlError("invalid_request", envelope.error.issues[0]?.message ?? "invalid control request");
    }
    const response = RsiControlResponseSchema.safeParse(await this.#transport(envelope.data));
    if (!response.success) {
      throw new RsiControlError("internal", "control service returned a malformed response");
    }
    if (!response.data.ok) {
      throw new RsiControlError(response.data.error.code, response.data.error.message);
    }
    return response.data.result;
  }
}

export { RsiControlError, type RsiControlErrorCode };
