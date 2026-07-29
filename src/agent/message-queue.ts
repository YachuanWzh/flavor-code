export type AgentQueueKind = "steer" | "followUp";
export type AgentQueueMode = "one-at-a-time" | "all";

export interface AgentQueueSnapshot {
  steering: readonly string[];
  followUp: readonly string[];
}

export interface AgentMessageQueueOptions {
  steeringMode?: AgentQueueMode;
  followUpMode?: AgentQueueMode;
}

export class AgentMessageQueue {
  readonly #steering: string[] = [];
  readonly #followUp: string[] = [];
  readonly #steeringMode: AgentQueueMode;
  readonly #followUpMode: AgentQueueMode;

  constructor(options: AgentMessageQueueOptions = {}) {
    this.#steeringMode = options.steeringMode ?? "one-at-a-time";
    this.#followUpMode = options.followUpMode ?? "one-at-a-time";
  }

  get hasPending(): boolean { return this.#steering.length > 0 || this.#followUp.length > 0; }

  enqueue(kind: AgentQueueKind, message: string): void {
    const value = message.trim();
    if (value.length === 0) throw new Error("Cannot queue an empty message");
    this.#items(kind).push(value);
  }

  drain(kind: AgentQueueKind): string[] {
    const items = this.#items(kind);
    const count = (kind === "steer" ? this.#steeringMode : this.#followUpMode) === "all"
      ? items.length
      : Math.min(1, items.length);
    return items.splice(0, count);
  }

  snapshot(): AgentQueueSnapshot {
    return { steering: [...this.#steering], followUp: [...this.#followUp] };
  }

  clear(): AgentQueueSnapshot {
    const snapshot = this.snapshot();
    this.#steering.length = 0;
    this.#followUp.length = 0;
    return snapshot;
  }

  #items(kind: AgentQueueKind): string[] {
    return kind === "steer" ? this.#steering : this.#followUp;
  }
}
