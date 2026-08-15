import { randomUUID } from "node:crypto";
import { Socket } from "node:net";

import { loadOrCreatePalAuthToken, validatePalAuthToken } from "./auth.js";

import {
  BrokerRequestSchema,
  BrokerResponseSchema,
  CoWorkSnapshotSchema,
  DeliveryReceiptSchema,
  encodeControlFrame,
  MAX_CONTROL_FRAME_BYTES,
  PalPresenceListSchema,
  PalPresenceSchema,
  type BrokerEvent,
  type BrokerRequest,
  type CoWorkParticipant,
  type CoWorkPlan,
  type CoWorkSnapshot,
  type DeliveryReceipt,
  type PalPresence,
} from "./protocol.js";

export interface PalClientRegistration {
  id: string;
  alias: string;
  projectPath: string;
}

export interface PalClientOptions {
  address: string;
  registration: PalClientRegistration;
  requestTimeoutMs?: number;
  heartbeatIntervalMs?: number;
  reconnectMinDelayMs?: number;
  reconnectMaxDelayMs?: number;
  connect?: (address: string) => Socket;
  startBroker?: () => Promise<void>;
  authToken?: string;
  authHome?: string;
}

export type CoWorkAction =
  | { type: "cowork-accept"; coWorkId: string; epoch: number }
  | { type: "cowork-plan"; plan: CoWorkPlan }
  | { type: "cowork-plan-accept"; coWorkId: string; epoch: number; planHash: string }
  | { type: "cowork-ready"; coWorkId: string; epoch: number; planHash: string }
  | { type: "cowork-complete"; coWorkId: string; epoch: number; planHash: string; passed: boolean; detail?: string }
  | { type: "cowork-integration"; coWorkId: string; epoch: number; planHash: string; passed: boolean; evidence: string };

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 10_000;
const DEFAULT_RECONNECT_MIN_DELAY_MS = 50;
const DEFAULT_RECONNECT_MAX_DELAY_MS = 2_000;
const EVENT_DEDUP_LIMIT = 2_048;

function positive(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be positive`);
  return value;
}

function defaultConnect(address: string): Socket {
  const socket = new Socket();
  socket.connect(address);
  return socket;
}

function eventKey(event: BrokerEvent): string {
  switch (event.type) {
    case "chat-event": return `chat:${event.messageId}:${event.recipientId}`;
    case "task-event": return `task:${event.messageId}:${event.taskId}:${event.status}`;
    case "delivery-receipt": return `receipt:${event.messageId}:${event.status}`;
    case "cowork-event": return `cowork:${event.coWorkId}:${event.epoch}:${event.action}:${event.planHash ?? "none"}`;
  }
}

export class PalClient {
  private readonly address: string;
  private readonly requestTimeoutMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly reconnectMinDelayMs: number;
  private readonly reconnectMaxDelayMs: number;
  private readonly connectSocket: (address: string) => Socket;
  private readonly startBroker: (() => Promise<void>) | undefined;
  private readonly listeners = new Set<(event: BrokerEvent) => void>();
  private readonly pending = new Map<string, PendingRequest>();
  private readonly seenEvents = new Set<string>();
  private registration: PalClientRegistration;
  private socket: Socket | undefined;
  private buffer = Buffer.alloc(0);
  private starting: Promise<PalPresence> | undefined;
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private connectingReject: ((error: Error) => void) | undefined;
  private reconnectDelayMs: number;
  private closed = false;
  private registered = false;
  private heartbeatPending = false;
  private authToken: string | undefined;
  private readonly authHome: string | undefined;

  constructor(options: PalClientOptions) {
    this.address = options.address;
    this.registration = { ...options.registration };
    this.requestTimeoutMs = positive(options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS, "requestTimeoutMs");
    this.heartbeatIntervalMs = positive(options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS, "heartbeatIntervalMs");
    this.reconnectMinDelayMs = positive(options.reconnectMinDelayMs ?? DEFAULT_RECONNECT_MIN_DELAY_MS, "reconnectMinDelayMs");
    this.reconnectMaxDelayMs = positive(options.reconnectMaxDelayMs ?? DEFAULT_RECONNECT_MAX_DELAY_MS, "reconnectMaxDelayMs");
    if (this.reconnectMinDelayMs > this.reconnectMaxDelayMs) throw new Error("reconnectMinDelayMs must not exceed reconnectMaxDelayMs");
    this.reconnectDelayMs = this.reconnectMinDelayMs;
    this.connectSocket = options.connect ?? defaultConnect;
    this.startBroker = options.startBroker;
    this.authToken = options.authToken === undefined ? undefined : validatePalAuthToken(options.authToken);
    this.authHome = options.authHome;
  }

  start(): Promise<PalPresence> {
    if (this.closed) return Promise.reject(new Error("Pal client is closed"));
    if (this.starting !== undefined) return this.starting;
    this.starting = this.startInternal().catch((error: unknown) => {
      this.starting = undefined;
      throw error;
    });
    return this.starting;
  }

  async list(): Promise<PalPresence[]> {
    const data = await this.request({ version: 1, type: "list", requestId: randomUUID() });
    return PalPresenceListSchema.parse(data);
  }

  async rename(alias: string): Promise<PalPresence> {
    const previous = this.registration;
    this.registration = { ...previous, alias };
    try {
      return await this.register();
    } catch (error) {
      this.registration = previous;
      throw error;
    }
  }

  async sendTask(target: string, message: string, messageId: string = randomUUID()): Promise<DeliveryReceipt> {
    const data = await this.request({ version: 1, type: "task", requestId: randomUUID(), messageId, target, goal: message });
    return DeliveryReceiptSchema.parse(data);
  }

  async sendChat(target: string, message: string, messageId: string = randomUUID()): Promise<DeliveryReceipt> {
    const data = await this.request({ version: 1, type: "chat", requestId: randomUUID(), messageId, target, message });
    return DeliveryReceiptSchema.parse(data);
  }

  async startCoWork(input: { coWorkId?: string; goal: string; participants: CoWorkParticipant[] }): Promise<CoWorkSnapshot> {
    const data = await this.request({
      version: 1,
      type: "cowork-propose",
      requestId: randomUUID(),
      coWorkId: input.coWorkId ?? randomUUID(),
      goal: input.goal,
      participants: input.participants,
    });
    return CoWorkSnapshotSchema.parse(data);
  }

  async coWorkAction(action: CoWorkAction): Promise<CoWorkSnapshot> {
    const request = { version: 1 as const, requestId: randomUUID(), ...action } as BrokerRequest;
    return CoWorkSnapshotSchema.parse(await this.request(request));
  }

  async coWorkStatus(coWorkId: string): Promise<CoWorkSnapshot> {
    const data = await this.request({ version: 1, type: "cowork-get", requestId: randomUUID(), coWorkId });
    return CoWorkSnapshotSchema.parse(data);
  }

  async integrateCoWork(input: { coWorkId: string; epoch: number; planHash: string; passed: boolean; evidence: string }): Promise<CoWorkSnapshot> {
    return this.coWorkAction({ type: "cowork-integration", ...input });
  }

  async cancelCoWork(coWorkId: string, reason: string): Promise<CoWorkSnapshot> {
    const data = await this.request({ version: 1, type: "cowork-cancel", requestId: randomUUID(), coWorkId, reason });
    return CoWorkSnapshotSchema.parse(data);
  }

  subscribe(listener: (event: BrokerEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    if (this.registered && this.socket !== undefined) {
      let disconnectTimer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        this.request({ version: 1, type: "disconnect", requestId: randomUUID() }).catch(() => undefined),
        new Promise<void>((resolve) => { disconnectTimer = setTimeout(resolve, Math.min(this.requestTimeoutMs, 250)); }),
      ]);
      if (disconnectTimer !== undefined) clearTimeout(disconnectTimer);
    }
    this.closed = true;
    this.registered = false;
    this.heartbeatPending = false;
    if (this.reconnectTimer !== undefined) clearTimeout(this.reconnectTimer);
    if (this.heartbeatTimer !== undefined) clearInterval(this.heartbeatTimer);
    this.reconnectTimer = undefined;
    this.heartbeatTimer = undefined;
    this.connectingReject?.(new Error("Pal client closed"));
    this.connectingReject = undefined;
    this.rejectPending(new Error("Pal client closed"));
    const socket = this.socket;
    this.socket = undefined;
    if (socket !== undefined) {
      socket.removeAllListeners();
      socket.end();
      socket.destroy();
    }
  }

  private async startInternal(): Promise<PalPresence> {
    this.authToken ??= await loadOrCreatePalAuthToken(this.authHome === undefined ? {} : { home: this.authHome });
    if (this.closed) throw new Error("Pal client is closed");
    try {
      await this.openSocket();
    } catch (firstError) {
      if (this.startBroker === undefined) throw firstError;
      await this.startBroker();
      await this.openSocket();
    }
    let presence: PalPresence;
    try {
      presence = await this.register();
    } catch (error) {
      this.socket?.destroy();
      throw error;
    }
    this.registered = true;
    this.reconnectDelayMs = this.reconnectMinDelayMs;
    this.beginHeartbeat();
    return presence;
  }

  private openSocket(): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const rejectConnection = (error: Error) => {
        if (settled) return;
        settled = true;
        if (this.connectingReject === rejectConnection) this.connectingReject = undefined;
        reject(error);
      };
      this.connectingReject = rejectConnection;
      let socket: Socket;
      try {
        socket = this.connectSocket(this.address);
      } catch (error) {
        rejectConnection(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      this.socket = socket;
      this.buffer = Buffer.alloc(0);
      const onConnect = () => {
        if (settled) return;
        settled = true;
        if (this.connectingReject === rejectConnection) this.connectingReject = undefined;
        socket.off("error", onInitialError);
        resolve();
      };
      const onInitialError = (error: Error) => {
        socket.off("connect", onConnect);
        if (this.socket === socket) this.socket = undefined;
        socket.destroy();
        rejectConnection(error);
      };
      socket.once("connect", onConnect);
      socket.once("error", onInitialError);
      socket.on("data", (chunk: Buffer) => this.receive(socket, chunk));
      socket.once("close", () => this.handleSocketClose(socket));
      socket.on("error", () => undefined);
    });
  }

  private async register(): Promise<PalPresence> {
    const now = new Date().toISOString();
    const data = await this.request({
      version: 1,
      type: "register",
      requestId: randomUUID(),
      authToken: this.authToken,
      presence: { version: 1, ...this.registration, connectedAt: now, lastSeenAt: now },
    });
    return PalPresenceSchema.parse(data);
  }

  private request(request: BrokerRequest): Promise<unknown> {
    const socket = this.socket;
    if (this.closed || socket === undefined || socket.destroyed || !socket.writable) {
      return Promise.reject(new Error(this.closed ? "Pal client is closed" : "Pal client is not connected"));
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(request.requestId);
        reject(new Error(`Pal request '${request.type}' timed out`));
      }, this.requestTimeoutMs);
      this.pending.set(request.requestId, { resolve, reject, timer });
      let frame: string;
      try {
        frame = encodeControlFrame(BrokerRequestSchema.parse(request));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(request.requestId);
        reject(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      socket.write(frame, (error) => {
        if (error === null || error === undefined) return;
        const pending = this.pending.get(request.requestId);
        if (pending === undefined) return;
        clearTimeout(pending.timer);
        this.pending.delete(request.requestId);
        reject(error);
      });
    });
  }

  private receive(socket: Socket, chunk: Buffer): void {
    if (socket !== this.socket) return;
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (true) {
      const newline = this.buffer.indexOf(0x0a);
      if (newline < 0) {
        if (this.buffer.byteLength > MAX_CONTROL_FRAME_BYTES) socket.destroy(new Error("Broker frame is too large"));
        return;
      }
      if (newline > MAX_CONTROL_FRAME_BYTES) {
        socket.destroy(new Error("Broker frame is too large"));
        return;
      }
      const frame = this.buffer.subarray(0, newline).toString("utf8");
      this.buffer = this.buffer.subarray(newline + 1);
      let raw: unknown;
      try {
        raw = JSON.parse(frame);
      } catch {
        socket.destroy(new Error("Broker sent invalid JSON"));
        return;
      }
      const parsed = BrokerResponseSchema.safeParse(raw);
      if (!parsed.success) {
        socket.destroy(new Error("Broker sent an invalid response"));
        return;
      }
      const response = parsed.data;
      if (response.type === "event") {
        this.emit(response.event);
        continue;
      }
      const pending = this.pending.get(response.requestId);
      if (pending === undefined) continue;
      clearTimeout(pending.timer);
      this.pending.delete(response.requestId);
      if (response.type === "ok") pending.resolve(response.data);
      else pending.reject(new Error(`${response.code}: ${response.message}`));
    }
  }

  private emit(event: BrokerEvent): void {
    const key = eventKey(event);
    if (this.seenEvents.has(key)) return;
    this.seenEvents.add(key);
    while (this.seenEvents.size > EVENT_DEDUP_LIMIT) {
      const oldest = this.seenEvents.values().next().value as string | undefined;
      if (oldest === undefined) break;
      this.seenEvents.delete(oldest);
    }
    for (const listener of [...this.listeners]) listener(event);
  }

  private handleSocketClose(socket: Socket): void {
    if (this.socket !== socket) return;
    const shouldReconnect = this.registered;
    this.socket = undefined;
    this.registered = false;
    this.heartbeatPending = false;
    this.starting = undefined;
    this.rejectPending(new Error("Pal broker connection closed"));
    if (this.heartbeatTimer !== undefined) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
    if (!this.closed && shouldReconnect) this.scheduleReconnect();
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private beginHeartbeat(): void {
    if (this.heartbeatTimer !== undefined) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => {
      if (!this.registered) return;
      if (this.heartbeatPending) return;
      this.heartbeatPending = true;
      void this.request({ version: 1, type: "heartbeat", requestId: randomUUID() })
        .catch(() => undefined)
        .finally(() => { this.heartbeatPending = false; });
    }, this.heartbeatIntervalMs);
    this.heartbeatTimer.unref?.();
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== undefined || this.closed) return;
    const delay = this.reconnectDelayMs;
    this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, this.reconnectMaxDelayMs);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.start().catch(() => this.scheduleReconnect());
    }, delay);
    this.reconnectTimer.unref?.();
  }
}
