import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { chmod, lstat, mkdir, unlink } from "node:fs/promises";
import { createServer, Socket, type Server } from "node:net";
import { dirname } from "node:path";

import { loadOrCreatePalAuthToken, validatePalAuthToken } from "./auth.js";
import { acquirePalFileLock, type PalFileLock } from "./lifecycle.js";

import {
  CoWorkPlanSchema,
  CoWorkProposalParticipantsSchema,
  CoWorkSnapshotSchema,
  DeliveryReceiptSchema,
  BrokerRequestSchema,
  BrokerResponseSchema,
  encodeControlFrame,
  MAX_ACTIVE_PALS,
  MAX_CONTROL_FRAME_BYTES,
  MIN_UUID_PREFIX_LENGTH,
  normalizePalIdentity,
  PalPresenceSchema,
  type BrokerEvent,
  type BrokerRequest,
  type BrokerResponse,
  type CoWorkParticipant,
  type CoWorkPlan,
  type CoWorkSnapshot,
  type DeliveryReceipt,
  type PalPresence,
  type PalTaskEvent,
} from "./protocol.js";

export type BrokerStateErrorCode =
  | "alias-conflict"
  | "ambiguous-target"
  | "not-found"
  | "invalid-transition"
  | "stale-epoch"
  | "capacity";

export class BrokerStateError extends Error {
  constructor(
    public readonly code: BrokerStateErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "BrokerStateError";
  }
}

export interface PalBrokerServerOptions {
  address: string;
  platform?: NodeJS.Platform;
  state?: PalBrokerState;
  maxFrameBytes?: number;
  authToken?: string;
  authHome?: string;
  processAlive?: (pid: number) => boolean;
  probeAddress?: (address: string) => Promise<boolean>;
}

interface BrokerConnection {
  socket: Socket;
  buffer: Buffer;
  palId?: string;
}

const WINDOWS_PIPE_PREFIX = "\\\\.\\pipe\\";

function canConnect(address: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new Socket();
    const finish = (connected: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(connected);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.connect(address);
  });
}

export function isWindowsPipeAddress(address: string, platform: NodeJS.Platform = process.platform): boolean {
  return platform === "win32" && address.toLowerCase().startsWith(WINDOWS_PIPE_PREFIX);
}

export class PalBrokerServer {
  public readonly address: string;
  public lastActivityAt = Date.now();

  private readonly platform: NodeJS.Platform;
  private readonly state: PalBrokerState;
  private readonly maxFrameBytes: number;
  private readonly server: Server;
  private readonly connections = new Set<BrokerConnection>();
  private readonly palConnections = new Map<string, BrokerConnection>();
  private started = false;
  private ownsAddress = false;
  private closing?: Promise<void>;
  private authToken: string | undefined;
  private readonly authHome: string | undefined;
  private readonly processAlive: ((pid: number) => boolean) | undefined;
  private readonly probeAddress: (address: string) => Promise<boolean>;
  private endpointLock: PalFileLock | undefined;

  constructor(options: PalBrokerServerOptions) {
    this.address = options.address;
    this.platform = options.platform ?? process.platform;
    this.state = options.state ?? new PalBrokerState();
    this.maxFrameBytes = options.maxFrameBytes ?? MAX_CONTROL_FRAME_BYTES;
    if (!Number.isSafeInteger(this.maxFrameBytes) || this.maxFrameBytes <= 0 || this.maxFrameBytes > MAX_CONTROL_FRAME_BYTES) {
      throw new Error(`maxFrameBytes must be a positive integer not exceeding ${MAX_CONTROL_FRAME_BYTES}`);
    }
    this.authToken = options.authToken === undefined ? undefined : validatePalAuthToken(options.authToken);
    this.authHome = options.authHome;
    this.processAlive = options.processAlive;
    this.probeAddress = options.probeAddress ?? canConnect;
    this.server = createServer((socket) => this.accept(socket));
  }

  get connectionCount(): number {
    return this.connections.size;
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.authToken ??= await loadOrCreatePalAuthToken(this.authHome === undefined ? {} : { home: this.authHome });
    try {
      await this.prepareAddress();
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => {
          this.server.off("listening", onListening);
          reject(error);
        };
        const onListening = () => {
          this.server.off("error", onError);
          this.started = true;
          this.ownsAddress = true;
          resolve();
        };
        this.server.once("error", onError);
        this.server.once("listening", onListening);
        this.server.listen(this.address);
      });
    } catch (error) {
      await this.releaseEndpointLock();
      throw error;
    }
  }

  sweep(): void {
    const active = new Set(this.state.list().map(({ id }) => id));
    for (const [palId, connection] of this.palConnections) {
      if (active.has(palId)) continue;
      this.palConnections.delete(palId);
      connection.socket.destroy();
    }
  }

  close(): Promise<void> {
    if (this.closing !== undefined) return this.closing;
    this.closing = this.closeOnce();
    return this.closing;
  }

  private async closeOnce(): Promise<void> {
    const ownsAddress = this.ownsAddress;
    for (const connection of this.connections) connection.socket.destroy();
    if (this.started) {
      await new Promise<void>((resolve) => this.server.close(() => resolve()));
      this.started = false;
    }
    this.ownsAddress = false;
    if (ownsAddress && !isWindowsPipeAddress(this.address, this.platform)) await this.unlinkKnownSocket();
    await this.releaseEndpointLock();
  }

  private async prepareAddress(): Promise<void> {
    if (isWindowsPipeAddress(this.address, this.platform)) return;
    const parent = dirname(this.address);
    await mkdir(parent, { recursive: true, mode: 0o700 });
    await chmod(parent, 0o700);
    this.endpointLock = await acquirePalFileLock({
      path: `${this.address}.owner.lock`,
      endpointLive: () => this.probeAddress(this.address),
      ...(this.processAlive === undefined ? {} : { processAlive: this.processAlive }),
    });
    if (this.endpointLock === undefined) throw new Error(`Pals endpoint '${this.address}' is active or owned`);
    try {
      const stat = await lstat(this.address);
      if (!stat.isSocket()) throw new Error(`Refusing to unlink '${this.address}' because it is not a socket`);
      await unlink(this.address);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  private async releaseEndpointLock(): Promise<void> {
    const lock = this.endpointLock;
    this.endpointLock = undefined;
    await lock?.release();
  }

  private async unlinkKnownSocket(): Promise<void> {
    try {
      const stat = await lstat(this.address);
      if (stat.isSocket()) await unlink(this.address);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  private accept(socket: Socket): void {
    const connection: BrokerConnection = { socket, buffer: Buffer.alloc(0) };
    this.connections.add(connection);
    this.lastActivityAt = Date.now();
    socket.on("data", (chunk: Buffer) => this.receive(connection, chunk));
    socket.on("error", () => undefined);
    socket.once("close", () => this.remove(connection));
  }

  private remove(connection: BrokerConnection): void {
    this.connections.delete(connection);
    if (connection.palId !== undefined && this.palConnections.get(connection.palId) === connection) {
      this.palConnections.delete(connection.palId);
      this.state.disconnect(connection.palId);
    }
    this.lastActivityAt = Date.now();
  }

  private receive(connection: BrokerConnection, chunk: Buffer): void {
    this.lastActivityAt = Date.now();
    connection.buffer = Buffer.concat([connection.buffer, chunk]);
    while (!connection.socket.destroyed) {
      const newline = connection.buffer.indexOf(0x0a);
      if (newline < 0) {
        if (connection.buffer.byteLength > this.maxFrameBytes) connection.socket.destroy();
        return;
      }
      if (newline > this.maxFrameBytes) {
        connection.socket.destroy();
        return;
      }
      const frame = connection.buffer.subarray(0, newline).toString("utf8");
      connection.buffer = connection.buffer.subarray(newline + 1);
      this.handleFrame(connection, frame);
    }
  }

  private handleFrame(connection: BrokerConnection, frame: string): void {
    let raw: unknown;
    try {
      raw = JSON.parse(frame);
    } catch {
      connection.socket.destroy();
      return;
    }
    const parsed = BrokerRequestSchema.safeParse(raw);
    if (!parsed.success) {
      const requestId = typeof raw === "object" && raw !== null && "requestId" in raw
        ? (raw as { requestId?: unknown }).requestId
        : undefined;
      if (typeof requestId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId)) {
        connection.socket.destroy();
        return;
      }
      this.send(connection, { version: 1, type: "error", requestId, code: "invalid-request", message: "Invalid request" });
      return;
    }
    void this.dispatch(connection, parsed.data);
  }

  private dispatch(connection: BrokerConnection, request: BrokerRequest): void {
    try {
      if (request.type === "register") {
        if (!this.authenticates(request.authToken)) {
          this.send(connection, { version: 1, type: "error", requestId: request.requestId, code: "authentication-failed", message: "Local authentication failed" });
          return;
        }
        const id = request.presence.id.toLowerCase();
        if (connection.palId !== undefined && connection.palId !== id) {
          throw new BrokerStateError("invalid-transition", "A connection cannot change its pal identity");
        }
        const occupied = this.palConnections.get(id);
        if (occupied !== undefined && occupied !== connection) {
          throw new BrokerStateError("alias-conflict", `Pal '${id}' is already connected`);
        }
        const presence = this.state.register({ id, alias: request.presence.alias, projectPath: request.presence.projectPath });
        connection.palId = id;
        this.palConnections.set(id, connection);
        this.ok(connection, request.requestId, presence);
        return;
      }
      const actorId = this.requireRegistered(connection);
      switch (request.type) {
        case "heartbeat":
          this.ok(connection, request.requestId, this.state.heartbeat(actorId));
          return;
        case "list":
          this.ok(connection, request.requestId, this.state.list());
          return;
        case "disconnect":
          this.state.disconnect(actorId);
          if (this.palConnections.get(actorId) === connection) this.palConnections.delete(actorId);
          this.ok(connection, request.requestId, null);
          connection.socket.end();
          return;
        case "chat": {
          const result = this.state.routeChat(actorId, request);
          this.deliver(result.deliveries);
          this.ok(connection, request.requestId, result.receipt);
          return;
        }
        case "task": {
          const result = this.state.routeTask(actorId, request);
          this.deliver(result.deliveries);
          this.ok(connection, request.requestId, result.receipt);
          return;
        }
        case "cowork-propose": {
          const result = this.state.proposeCoWork(actorId, request);
          this.deliverCoWork(result.events, result.snapshot.participants.map(({ palId }) => palId));
          this.ok(connection, request.requestId, result.snapshot);
          return;
        }
        case "cowork-accept": {
          const result = this.state.acceptCoWork(actorId, request.coWorkId, request.epoch);
          this.deliverCoWork(result.events, result.snapshot.participants.map(({ palId }) => palId));
          this.ok(connection, request.requestId, result.snapshot);
          return;
        }
        case "cowork-plan": {
          const result = this.state.submitCoWorkPlan(actorId, request.plan);
          this.deliverCoWork(result.events, result.snapshot.participants.map(({ palId }) => palId));
          this.ok(connection, request.requestId, result.snapshot);
          return;
        }
        case "cowork-plan-accept": {
          const result = this.state.acceptCoWorkPlan(actorId, request);
          this.deliverCoWork(result.events, result.snapshot.participants.map(({ palId }) => palId));
          this.ok(connection, request.requestId, result.snapshot);
          return;
        }
        case "cowork-ready": {
          const result = this.state.markCoWorkReady(actorId, request);
          this.deliverCoWork(result.events, result.snapshot.participants.map(({ palId }) => palId));
          this.ok(connection, request.requestId, result.snapshot);
          return;
        }
        case "cowork-complete": {
          const result = this.state.completeCoWork(actorId, request.detail === undefined ? {
            coWorkId: request.coWorkId,
            epoch: request.epoch,
            planHash: request.planHash,
            passed: request.passed,
          } : {
            coWorkId: request.coWorkId,
            epoch: request.epoch,
            planHash: request.planHash,
            passed: request.passed,
            detail: request.detail,
          });
          this.deliverCoWork(result.events, result.snapshot.participants.map(({ palId }) => palId));
          this.ok(connection, request.requestId, result.snapshot);
          return;
        }
        case "cowork-integration": {
          const result = this.state.integrateCoWork(actorId, {
            coWorkId: request.coWorkId,
            epoch: request.epoch,
            planHash: request.planHash,
            passed: request.passed,
            evidence: request.evidence,
          });
          this.deliverCoWork(result.events, result.snapshot.participants.map(({ palId }) => palId));
          this.ok(connection, request.requestId, result.snapshot);
          return;
        }
        case "cowork-get":
          this.ok(connection, request.requestId, this.state.getCoWork(request.coWorkId));
          return;
        case "cowork-cancel": {
          const result = this.state.cancelCoWork(actorId, request.coWorkId, request.reason);
          this.deliverCoWork(result.events, result.snapshot.participants.map(({ palId }) => palId));
          this.ok(connection, request.requestId, result.snapshot);
          return;
        }
      }
    } catch (error) {
      const stateError = error instanceof BrokerStateError ? error : undefined;
      const code = stateError?.code === "capacity" ? "invalid-transition" : (stateError?.code ?? "invalid-request");
      this.send(connection, {
        version: 1,
        type: "error",
        requestId: request.requestId,
        code,
        message: error instanceof Error ? error.message : "Request failed",
      });
    }
  }

  private requireRegistered(connection: BrokerConnection): string {
    if (connection.palId === undefined) throw new BrokerStateError("invalid-transition", "Register before sending requests");
    return connection.palId;
  }

  private authenticates(candidate: string | undefined): boolean {
    if (candidate === undefined || this.authToken === undefined) return false;
    const expected = Buffer.from(this.authToken, "hex");
    const received = Buffer.from(candidate, "hex");
    return received.byteLength === expected.byteLength && timingSafeEqual(received, expected);
  }

  private ok(connection: BrokerConnection, requestId: string, data: unknown): void {
    this.send(connection, { version: 1, type: "ok", requestId, data });
  }

  private send(connection: BrokerConnection, response: BrokerResponse): void {
    if (connection.socket.destroyed || !connection.socket.writable) return;
    try {
      connection.socket.write(encodeControlFrame(BrokerResponseSchema.parse(response)));
    } catch {
      connection.socket.destroy();
    }
  }

  private deliver(deliveries: Array<{ recipientId: string; event: BrokerEvent }>): void {
    for (const delivery of deliveries) {
      const recipient = this.palConnections.get(delivery.recipientId);
      if (recipient !== undefined) this.send(recipient, { version: 1, type: "event", event: delivery.event });
    }
  }

  private deliverCoWork(events: BrokerEvent[], participantIds: string[]): void {
    for (const event of events) {
      this.deliver(participantIds.map((recipientId) => ({ recipientId, event })));
    }
  }
}

export interface PalBrokerStateOptions {
  now?: () => number;
  idFactory?: () => string;
  heartbeatTimeoutMs?: number;
  dedupLimit?: number;
  maxPals?: number;
  maxCoWorks?: number;
}

export interface PalRegistration {
  id: string;
  alias: string;
  projectPath: string;
}

export interface RouteResult<TEvent extends BrokerEvent> {
  receipt: DeliveryReceipt;
  deliveries: Array<{ recipientId: string; event: TEvent }>;
}

export interface CoWorkTransition {
  snapshot: CoWorkSnapshot;
  events: BrokerEvent[];
}

interface PresenceRecord {
  presence: PalPresence;
  lastSeenMs: number;
}

interface CoWorkRecord {
  snapshot: CoWorkSnapshot;
}

const DEFAULT_HEARTBEAT_TIMEOUT_MS = 30_000;
const DEFAULT_DEDUP_LIMIT = 2_048;
const DEFAULT_MAX_PALS = MAX_ACTIVE_PALS;
const DEFAULT_MAX_COWORKS = 64;

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalize(child)]),
    );
  }
  return value;
}

export function canonicalPlanHash(input: CoWorkPlan): string {
  const plan = CoWorkPlanSchema.parse(input);
  return createHash("sha256").update(JSON.stringify(canonicalize(plan)), "utf8").digest("hex");
}

function sameParticipants(left: readonly CoWorkParticipant[], right: readonly CoWorkParticipant[]): boolean {
  const normalize = (participants: readonly CoWorkParticipant[]) => participants
    .map((participant) => `${participant.palId.toLowerCase()}:${participant.required ? "1" : "0"}`)
    .sort();
  return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
}

function includesAll(values: readonly string[], required: readonly string[]): boolean {
  const present = new Set(values);
  return required.every((id) => present.has(id));
}

function appendUnique(values: readonly string[], value: string): string[] {
  return values.includes(value) ? [...values] : [...values, value];
}

export class PalBrokerState {
  private readonly now: () => number;
  private readonly idFactory: () => string;
  private readonly heartbeatTimeoutMs: number;
  private readonly dedupLimit: number;
  private readonly maxPals: number;
  private readonly maxCoWorks: number;
  private readonly pals = new Map<string, PresenceRecord>();
  private readonly aliases = new Map<string, string>();
  private readonly delivered = new Map<string, string[]>();
  private coWorks = new Map<string, CoWorkRecord>();

  constructor(options: PalBrokerStateOptions = {}) {
    this.now = options.now ?? Date.now;
    this.idFactory = options.idFactory ?? randomUUID;
    this.heartbeatTimeoutMs = positiveInteger(options.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS, "heartbeatTimeoutMs");
    this.dedupLimit = positiveInteger(options.dedupLimit ?? DEFAULT_DEDUP_LIMIT, "dedupLimit");
    this.maxPals = positiveInteger(options.maxPals ?? DEFAULT_MAX_PALS, "maxPals");
    if (this.maxPals > MAX_ACTIVE_PALS) throw new Error(`maxPals must not exceed ${MAX_ACTIVE_PALS}`);
    this.maxCoWorks = positiveInteger(options.maxCoWorks ?? DEFAULT_MAX_COWORKS, "maxCoWorks");
  }

  register(registration: PalRegistration): PalPresence {
    this.sweepExpired();
    const id = registration.id.toLowerCase();
    const aliasKey = normalizePalIdentity(registration.alias);
    const claimedBy = this.aliases.get(aliasKey);
    if (claimedBy !== undefined && claimedBy !== id) {
      throw new BrokerStateError("alias-conflict", `Alias '${registration.alias}' is already active`);
    }
    if (!this.pals.has(id) && this.pals.size >= this.maxPals) {
      throw new BrokerStateError("capacity", "Pal capacity reached");
    }

    const existing = this.pals.get(id);
    if (existing !== undefined) this.aliases.delete(existing.presence.alias.toLocaleLowerCase("en-US"));
    const now = this.now();
    const presence = PalPresenceSchema.parse({
      version: 1,
      id,
      alias: registration.alias,
      projectPath: registration.projectPath,
      connectedAt: existing?.presence.connectedAt ?? new Date(now).toISOString(),
      lastSeenAt: new Date(now).toISOString(),
    });
    this.pals.set(id, { presence, lastSeenMs: now });
    this.aliases.set(aliasKey, id);
    return clone(presence);
  }

  list(): PalPresence[] {
    this.sweepExpired();
    return [...this.pals.values()]
      .map(({ presence }) => clone(presence))
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  resolveTarget(target: string): PalPresence {
    this.sweepExpired();
    const normalized = normalizePalIdentity(target);
    const aliasId = this.aliases.get(normalized);
    if (aliasId !== undefined) return clone(this.pals.get(aliasId)!.presence);

    const exact = this.pals.get(normalized);
    if (exact !== undefined) return clone(exact.presence);
    if (normalized.length >= MIN_UUID_PREFIX_LENGTH) {
      const matches = [...this.pals.entries()].filter(([id]) => id.startsWith(normalized));
      if (matches.length === 1) return clone(matches[0]![1].presence);
      if (matches.length > 1) {
        throw new BrokerStateError("ambiguous-target", `Target '${target}' matches multiple active pals`);
      }
    }
    throw new BrokerStateError("not-found", `No active pal matches '${target}'`);
  }

  heartbeat(palId: string): PalPresence {
    this.sweepExpired();
    const key = palId.toLowerCase();
    const record = this.pals.get(key);
    if (record === undefined) throw new BrokerStateError("not-found", `Pal '${palId}' is not active`);
    const now = this.now();
    record.lastSeenMs = now;
    record.presence = { ...record.presence, lastSeenAt: new Date(now).toISOString() };
    return clone(record.presence);
  }

  disconnect(palId: string): void {
    const key = palId.toLowerCase();
    const record = this.pals.get(key);
    if (record === undefined) return;
    this.pals.delete(key);
    this.aliases.delete(record.presence.alias.toLocaleLowerCase("en-US"));
  }

  routeChat(senderId: string, input: { messageId: string; target: string; message: string }): RouteResult<Extract<BrokerEvent, { type: "chat-event" }>> {
    const sender = this.requirePal(senderId);
    const recipient = this.resolveTarget(input.target);
    const duplicate = this.duplicateReceipt(input.messageId);
    if (duplicate !== undefined) return { receipt: duplicate, deliveries: [] };
    const event = {
      version: 1 as const,
      type: "chat-event" as const,
      messageId: input.messageId,
      senderId: sender.id,
      recipientId: recipient.id,
      message: input.message,
    };
    const receipt = this.rememberDelivery(input.messageId, [recipient.id]);
    return { receipt, deliveries: [{ recipientId: recipient.id, event }] };
  }

  routeTask(senderId: string, input: { messageId: string; target: string; goal: string }): RouteResult<PalTaskEvent> {
    const sender = this.requirePal(senderId);
    const recipient = this.resolveTarget(input.target);
    const duplicate = this.duplicateReceipt(input.messageId);
    if (duplicate !== undefined) return { receipt: duplicate, deliveries: [] };
    const event: PalTaskEvent = {
      version: 1,
      type: "task-event",
      messageId: input.messageId,
      taskId: this.idFactory(),
      senderId: sender.id,
      recipientId: recipient.id,
      status: "accepted",
      detail: input.goal,
    };
    const receipt = this.rememberDelivery(input.messageId, [recipient.id]);
    return { receipt, deliveries: [{ recipientId: recipient.id, event }] };
  }

  proposeCoWork(
    actorId: string,
    input: { coWorkId: string; goal: string; participants: CoWorkParticipant[] },
  ): CoWorkTransition {
    const actor = this.requirePal(actorId);
    if (this.coWorks.has(input.coWorkId)) throw new BrokerStateError("invalid-transition", "Co-work already exists");
    const roster = CoWorkProposalParticipantsSchema.safeParse(input.participants);
    if (!roster.success) {
      throw new BrokerStateError("invalid-transition", "Co-work requires at least two distinct participants");
    }
    for (const participant of roster.data) this.requirePal(participant.palId);
    if (!roster.data.some((participant) => participant.palId === actor.id)) {
      throw new BrokerStateError("invalid-transition", "Proposer must be a participant");
    }
    const integrationOwner = roster.data.find(({ required }) => required);
    if (integrationOwner === undefined) {
      throw new BrokerStateError("invalid-transition", "Co-work requires at least one required participant");
    }
    const acceptedParticipantIds = [actor.id];
    const requiredParticipantIds = roster.data.filter(({ required }) => required).map(({ palId }) => palId);
    const snapshot = CoWorkSnapshotSchema.parse({
      version: 1,
      coWorkId: input.coWorkId,
      epoch: 1,
      phase: includesAll(acceptedParticipantIds, requiredParticipantIds) ? "planning" : "proposed",
      goal: input.goal,
      participants: roster.data,
      integrationOwnerId: integrationOwner.palId,
      acceptedParticipantIds,
      planHash: null,
      plan: null,
      planAcceptedParticipantIds: [],
      readyParticipantIds: [],
      completedParticipantIds: [],
      completionAssertions: [],
      integration: null,
    });
    const transition = this.transition(snapshot, actorId, "PROPOSE");
    const evictionCandidate = this.coWorkEvictionCandidate();
    const committed = new Map(this.coWorks);
    if (evictionCandidate !== undefined) committed.delete(evictionCandidate);
    committed.set(input.coWorkId, { snapshot });
    this.coWorks = committed;
    return transition;
  }

  acceptCoWork(actorId: string, coWorkId: string, epoch: number): CoWorkTransition {
    const record = this.requireCoWork(coWorkId);
    this.assertEpoch(record.snapshot, epoch);
    this.requireRequiredParticipant(record.snapshot, actorId);
    if (record.snapshot.phase !== "proposed") throw new BrokerStateError("invalid-transition", "Co-work is not awaiting acceptance");
    return this.mutateCoWork(record, actorId, (snapshot) => {
      snapshot.acceptedParticipantIds = appendUnique(snapshot.acceptedParticipantIds, actorId);
      if (includesAll(snapshot.acceptedParticipantIds, this.requiredIds(snapshot))) snapshot.phase = "planning";
    });
  }

  submitCoWorkPlan(actorId: string, input: CoWorkPlan): CoWorkTransition {
    const plan = CoWorkPlanSchema.parse(input);
    const record = this.requireCoWork(plan.coWorkId);
    this.requireRequiredParticipant(record.snapshot, actorId);
    if (record.snapshot.phase !== "planning" && record.snapshot.phase !== "prepared") {
      throw new BrokerStateError("invalid-transition", "Co-work is not accepting a plan");
    }
    const expectedEpoch = record.snapshot.plan === null ? record.snapshot.epoch : record.snapshot.epoch + 1;
    if (plan.epoch !== expectedEpoch) throw new BrokerStateError("stale-epoch", `Expected plan epoch ${expectedEpoch}`);
    if (plan.goal !== record.snapshot.goal || !sameParticipants(plan.participants, record.snapshot.participants)) {
      throw new BrokerStateError("invalid-transition", "Plan must preserve the accepted goal and participant roster");
    }
    return this.mutateCoWork(record, actorId, (snapshot) => {
      snapshot.epoch = plan.epoch;
      snapshot.phase = "planning";
      snapshot.plan = clone(plan);
      snapshot.planHash = canonicalPlanHash(plan);
      snapshot.planAcceptedParticipantIds = [];
      snapshot.readyParticipantIds = [];
      snapshot.completedParticipantIds = [];
      snapshot.completionAssertions = [];
      snapshot.integration = null;
      return "PLAN";
    });
  }

  acceptCoWorkPlan(
    actorId: string,
    token: { coWorkId: string; epoch: number; planHash: string },
  ): CoWorkTransition {
    const record = this.requireCoWork(token.coWorkId);
    this.assertPlanToken(record.snapshot, token);
    this.requireRequiredParticipant(record.snapshot, actorId);
    if (record.snapshot.phase === "prepared" && record.snapshot.planAcceptedParticipantIds.includes(actorId)) {
      return this.transition(record.snapshot, actorId);
    }
    if (record.snapshot.phase !== "planning" || record.snapshot.plan === null) {
      throw new BrokerStateError("invalid-transition", "Co-work plan is not awaiting acceptance");
    }
    return this.mutateCoWork(record, actorId, (snapshot) => {
      snapshot.planAcceptedParticipantIds = appendUnique(snapshot.planAcceptedParticipantIds, actorId);
      if (includesAll(snapshot.planAcceptedParticipantIds, this.requiredIds(snapshot))) snapshot.phase = "prepared";
    });
  }

  markCoWorkReady(
    actorId: string,
    token: { coWorkId: string; epoch: number; planHash: string },
  ): CoWorkTransition {
    const record = this.requireCoWork(token.coWorkId);
    this.assertPlanToken(record.snapshot, token);
    this.requireRequiredParticipant(record.snapshot, actorId);
    if (record.snapshot.phase === "running" && record.snapshot.readyParticipantIds.includes(actorId)) {
      return this.transition(record.snapshot, actorId);
    }
    if (record.snapshot.phase !== "planning" && record.snapshot.phase !== "prepared") {
      throw new BrokerStateError("invalid-transition", "Co-work is not accepting readiness");
    }
    if (!record.snapshot.planAcceptedParticipantIds.includes(actorId)) {
      throw new BrokerStateError("invalid-transition", "Participant must accept the current plan before becoming ready");
    }
    return this.mutateCoWork(record, actorId, (snapshot) => {
      snapshot.readyParticipantIds = appendUnique(snapshot.readyParticipantIds, actorId);
      if (includesAll(snapshot.planAcceptedParticipantIds, this.requiredIds(snapshot))
        && includesAll(snapshot.readyParticipantIds, this.requiredIds(snapshot))) {
        snapshot.phase = "running";
        return "START";
      }
    });
  }

  completeCoWork(
    actorId: string,
    input: { coWorkId: string; epoch: number; planHash: string; passed: boolean; detail?: string },
  ): CoWorkTransition {
    const record = this.requireCoWork(input.coWorkId);
    this.assertPlanToken(record.snapshot, input);
    this.requireRequiredParticipant(record.snapshot, actorId);
    if (record.snapshot.phase !== "running") throw new BrokerStateError("invalid-transition", "Co-work is not running");
    if (!record.snapshot.acceptedParticipantIds.includes(actorId) || !record.snapshot.readyParticipantIds.includes(actorId)) {
      throw new BrokerStateError("invalid-transition", "Participant must be accepted and ready before completing co-work");
    }
    if (record.snapshot.completionAssertions.some(({ participantId }) => participantId === actorId)) {
      return this.transition(record.snapshot, actorId);
    }
    return this.mutateCoWork(record, actorId, (snapshot) => {
      snapshot.completionAssertions.push(input.detail === undefined
        ? { participantId: actorId, passed: input.passed }
        : { participantId: actorId, passed: input.passed, detail: input.detail });
      if (!input.passed) {
        snapshot.phase = "failed";
        return "FAIL";
      }
      snapshot.completedParticipantIds = appendUnique(snapshot.completedParticipantIds, actorId);
      if (includesAll(snapshot.completedParticipantIds, this.requiredIds(snapshot))) snapshot.phase = "verifying";
    });
  }

  integrateCoWork(
    actorId: string,
    input: { coWorkId: string; epoch: number; planHash: string; passed: boolean; evidence: string },
  ): CoWorkTransition {
    const record = this.requireCoWork(input.coWorkId);
    this.assertPlanToken(record.snapshot, input);
    this.requireRequiredParticipant(record.snapshot, actorId);
    if (actorId !== record.snapshot.integrationOwnerId) {
      throw new BrokerStateError("invalid-transition", "Only the integration owner can finalize co-work integration");
    }
    if (record.snapshot.phase !== "verifying") throw new BrokerStateError("invalid-transition", "Co-work is not ready for integration verification");
    return this.mutateCoWork(record, actorId, (snapshot) => {
      snapshot.integration = { passed: input.passed, evidence: input.evidence };
      snapshot.phase = input.passed ? "completed" : "failed";
      return input.passed ? "END" : "FAIL";
    });
  }

  getCoWork(coWorkId: string): CoWorkSnapshot {
    return clone(this.requireCoWork(coWorkId).snapshot);
  }

  cancelCoWork(actorId: string, coWorkId: string, _reason: string): CoWorkTransition {
    const record = this.requireCoWork(coWorkId);
    this.requireRequiredParticipant(record.snapshot, actorId);
    if (record.snapshot.phase === "completed" || record.snapshot.phase === "failed" || record.snapshot.phase === "cancelled") {
      throw new BrokerStateError("invalid-transition", "Co-work is already terminal");
    }
    return this.mutateCoWork(record, actorId, (snapshot) => {
      snapshot.phase = "cancelled";
      return "CANCEL";
    });
  }

  private sweepExpired(): void {
    const cutoff = this.now() - this.heartbeatTimeoutMs;
    for (const [id, record] of this.pals) {
      if (record.lastSeenMs < cutoff) this.disconnect(id);
    }
  }

  private requirePal(palId: string): PalPresence {
    this.sweepExpired();
    const record = this.pals.get(palId.toLowerCase());
    if (record === undefined) throw new BrokerStateError("not-found", `Pal '${palId}' is not active`);
    return record.presence;
  }

  private duplicateReceipt(messageId: string): DeliveryReceipt | undefined {
    const recipientIds = this.delivered.get(messageId);
    if (recipientIds === undefined) return undefined;
    return DeliveryReceiptSchema.parse({
      version: 1,
      type: "delivery-receipt",
      messageId,
      status: "duplicate",
      recipientIds,
    });
  }

  private rememberDelivery(messageId: string, recipientIds: string[]): DeliveryReceipt {
    this.delivered.set(messageId, [...recipientIds]);
    while (this.delivered.size > this.dedupLimit) {
      const oldest = this.delivered.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.delivered.delete(oldest);
    }
    return DeliveryReceiptSchema.parse({
      version: 1,
      type: "delivery-receipt",
      messageId,
      status: "delivered",
      recipientIds,
    });
  }

  private requireCoWork(coWorkId: string): CoWorkRecord {
    const record = this.coWorks.get(coWorkId);
    if (record === undefined) throw new BrokerStateError("not-found", `Co-work '${coWorkId}' does not exist`);
    return record;
  }

  private requireParticipant(snapshot: CoWorkSnapshot, palId: string): void {
    if (!snapshot.participants.some((participant) => participant.palId === palId)) {
      throw new BrokerStateError("invalid-transition", `Pal '${palId}' is not a co-work participant`);
    }
  }

  private requireRequiredParticipant(snapshot: CoWorkSnapshot, palId: string): void {
    this.requireParticipant(snapshot, palId);
    if (!snapshot.participants.some((participant) => participant.palId === palId && participant.required)) {
      throw new BrokerStateError("invalid-transition", `Pal '${palId}' is an observer and cannot change co-work state`);
    }
  }

  private requiredIds(snapshot: CoWorkSnapshot): string[] {
    return snapshot.participants.filter(({ required }) => required).map(({ palId }) => palId);
  }

  private assertEpoch(snapshot: CoWorkSnapshot, epoch: number): void {
    if (epoch !== snapshot.epoch) throw new BrokerStateError("stale-epoch", `Expected epoch ${snapshot.epoch}`);
  }

  private assertPlanToken(snapshot: CoWorkSnapshot, token: { epoch: number; planHash: string }): void {
    this.assertEpoch(snapshot, token.epoch);
    if (snapshot.planHash === null || token.planHash !== snapshot.planHash) {
      throw new BrokerStateError("invalid-transition", "Plan hash does not match the canonical active plan");
    }
  }

  private transition(
    snapshot: CoWorkSnapshot,
    actorId: string,
    action?: "PROPOSE" | "PLAN" | "START" | "END" | "FAIL" | "CANCEL",
  ): CoWorkTransition {
    const result = CoWorkSnapshotSchema.parse(clone(snapshot));
    if (action === undefined) return { snapshot: result, events: [] };
    return {
      snapshot: result,
      events: [{
        version: 1,
        type: "cowork-event",
        action,
        actorId,
        coWorkId: result.coWorkId,
        epoch: result.epoch,
        planHash: result.planHash,
        snapshot: clone(result),
      }],
    };
  }

  private mutateCoWork(
    record: CoWorkRecord,
    actorId: string,
    mutate: (snapshot: CoWorkSnapshot) => "PLAN" | "START" | "END" | "FAIL" | "CANCEL" | undefined,
  ): CoWorkTransition {
    const candidate = clone(record.snapshot);
    const action = mutate(candidate);
    const committed = CoWorkSnapshotSchema.parse(candidate);
    record.snapshot = committed;
    return this.transition(committed, actorId, action);
  }

  private coWorkEvictionCandidate(): string | undefined {
    if (this.coWorks.size < this.maxCoWorks) return undefined;
    const terminal = [...this.coWorks.entries()].find(([, { snapshot }]) =>
      snapshot.phase === "completed" || snapshot.phase === "failed" || snapshot.phase === "cancelled");
    if (terminal === undefined) throw new BrokerStateError("capacity", "Active co-work capacity reached");
    return terminal[0];
  }
}
