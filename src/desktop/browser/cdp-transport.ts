/**
 * CDP transport over webContents.debugger. No remote debugging port is ever
 * opened. Commands carry a default timeout and AbortSignal support; a debugger
 * detach rejects every pending command with a transient error so callers can
 * re-attach or fail cleanly. See md_docs/todo.md section 12.
 */

import { BrowserError } from "./types.js";

export interface CdpMessage {
  method: string;
  params?: Record<string, unknown>;
  sessionId?: string;
}

export interface CdpEventListenerLike {
  on(event: "message", listener: (sender: unknown, message: CdpMessage) => void): void;
  on(event: "detach", listener: (sender: unknown, details: { reason: string }) => void): void;
  removeListener(event: "message", listener: (sender: unknown, message: CdpMessage) => void): void;
  removeListener(event: "detach", listener: (sender: unknown, details: { reason: string }) => void): void;
  sendCommand(
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string,
  ): Promise<unknown>;
}

export interface CdpDebuggerLike extends CdpEventListenerLike {
  attach(protocol?: string): void;
  detach(): void;
  isAttached(): boolean;
}

export const CDP_DEFAULT_TIMEOUT_MS = 15_000;
export const CDP_MAX_PENDING_COMMANDS = 512;

export interface CdpCommandOptions {
  sessionId?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

type MessageListener = (sender: unknown, message: CdpMessage) => void;
type DetachListener = (sender: unknown, details: { reason: string }) => void;

interface Subscription {
  method: string;
  sessionId: string | undefined;
  listener: (message: CdpMessage) => void;
}

export class CdpTransport {
  private readonly debugger_: CdpDebuggerLike;
  private readonly defaultTimeoutMs: number;
  private readonly subscriptions = new Set<Subscription>();
  private pending = new Map<number, {
    reject: (error: Error) => void;
    resolve: (value: unknown) => void;
    timer: NodeJS.Timeout;
    abortCleanup?: () => void;
  }>();
  private nextId = 1;
  private messageListener: MessageListener | undefined;
  private detachListener: DetachListener | undefined;
  private detached = true;
  private detachReason = "";
  private disposed = false;

  constructor(debugger_: CdpDebuggerLike, options: { timeoutMs?: number } = {}) {
    this.debugger_ = debugger_;
    this.defaultTimeoutMs = options.timeoutMs ?? CDP_DEFAULT_TIMEOUT_MS;
  }

  get isAttached(): boolean {
    return !this.detached && !this.disposed;
  }

  /** Attaches lazily and installs the shared event/detach listeners once. */
  attach(): void {
    if (this.disposed) {
      throw new BrowserError("detached", "Browser CDP transport is disposed", false);
    }
    if (!this.detached) return;
    if (!this.debugger_.isAttached()) this.debugger_.attach("1.3");
    this.removeDebuggerListeners();
    this.messageListener = (_sender, message) => this.dispatch(message);
    this.detachListener = (_sender, details) => this.onDebuggerDetached(details.reason);
    this.debugger_.on("message", this.messageListener);
    this.debugger_.on("detach", this.detachListener);
    this.detached = false;
    this.detachReason = "";
  }

  private removeDebuggerListeners(): void {
    if (this.messageListener !== undefined) {
      this.debugger_.removeListener("message", this.messageListener);
    }
    if (this.detachListener !== undefined) {
      this.debugger_.removeListener("detach", this.detachListener);
    }
    this.messageListener = undefined;
    this.detachListener = undefined;
  }

  sendCommand<T = unknown>(
    method: string,
    params?: Record<string, unknown>,
    options: CdpCommandOptions = {},
  ): Promise<T> {
    if (this.disposed) {
      return Promise.reject(new BrowserError("detached", "Browser CDP transport is disposed", false));
    }
    if (this.detached) {
      try {
        this.attach();
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
      }
    }
    if (this.pending.size >= CDP_MAX_PENDING_COMMANDS) {
      return Promise.reject(new BrowserError("detached", "Too many pending CDP commands", true));
    }
    const id = this.nextId++;
    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new BrowserError("detached", `CDP command ${method} timed out after ${timeoutMs}ms`, true));
      }, timeoutMs);
      const entry: NonNullable<unknown> & {
        reject: (error: Error) => void;
        resolve: (value: unknown) => void;
        timer: NodeJS.Timeout;
        abortCleanup?: () => void;
      } = {
        reject: (error: Error) => {
          clearTimeout(timer);
          entry.abortCleanup?.();
          this.pending.delete(id);
          reject(error);
        },
        resolve: (value: unknown) => {
          clearTimeout(timer);
          entry.abortCleanup?.();
          this.pending.delete(id);
          resolve(value as T);
        },
        timer,
      };
      if (options.signal !== undefined) {
        const signal = options.signal;
        const onAbort = (): void => {
          entry.reject(new BrowserError("detached", `CDP command ${method} aborted`, false));
        };
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener("abort", onAbort, { once: true });
        entry.abortCleanup = () => signal.removeEventListener("abort", onAbort);
      }
      this.pending.set(id, entry);
      this.debugger_
        .sendCommand(method, params, options.sessionId)
        .then(
          (value) => {
            if (this.pending.get(id) !== undefined) entry.resolve(value as T);
          },
          (error: unknown) => {
            if (this.pending.get(id) !== undefined) {
              entry.reject(error instanceof Error ? error : new Error(String(error)));
            }
          },
        );
    });
  }

  /** Subscribe to a CDP event; returns an unsubscribe function. */
  onEvent(
    method: string,
    listener: (message: CdpMessage) => void,
    sessionId?: string,
  ): () => void {
    const subscription: Subscription = { method, sessionId: sessionId ?? undefined, listener };
    this.subscriptions.add(subscription);
    return () => {
      this.subscriptions.delete(subscription);
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.rejectAllPending(new BrowserError("detached", "Browser CDP transport disposed", false));
    this.removeDebuggerListeners();
    this.subscriptions.clear();
    if (this.debugger_.isAttached()) {
      try {
        this.debugger_.detach();
      } catch {
        // Already gone; nothing left to detach from.
      }
    }
    this.detached = true;
  }

  /**
   * One recovery re-attach is allowed after an unexpected detach (for example
   * the user opened DevTools); sendCommand() re-attaches lazily after this.
   */
  private onDebuggerDetached(reason: string): void {
    this.detached = true;
    this.detachReason = reason;
    this.rejectAllPending(
      new BrowserError("detached", `Debugger detached (${reason || "devtools"}); re-attach required`, true),
    );
  }

  private rejectAllPending(error: BrowserError): void {
    const entries = [...this.pending.values()];
    this.pending.clear();
    for (const entry of entries) entry.reject(error);
  }

  private dispatch(message: CdpMessage): void {
    for (const subscription of this.subscriptions) {
      if (subscription.method !== message.method) continue;
      if (subscription.sessionId !== undefined && subscription.sessionId !== message.sessionId) continue;
      try {
        subscription.listener(message);
      } catch {
        // A faulty listener must never break the CDP event pump.
      }
    }
  }

  get detachReasonValue(): string {
    return this.detachReason;
  }
}
