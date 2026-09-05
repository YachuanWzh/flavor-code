import { createInterface } from "node:readline";
import type { Interface as ReadlineInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";

import type { AgentQueueSnapshot } from "../agent/message-queue.js";
import type { SessionOutput } from "../ui/session.js";
import type { SessionApprovalRequest } from "../ui/session.js";
import type { ApprovalDecision } from "../tools/runtime.js";
import { message } from "../utils/error.js";
import { RpcCommandSchema, type RpcCommand } from "./schema.js";

export interface RpcSessionLike {
  readonly active: boolean;
  start(): Promise<void>;
  submit(prompt: string): Promise<void>;
  steer(prompt: string): void;
  followUp(prompt: string): void;
  interrupt(): "cancelled" | "exit";
  queueSnapshot(): AgentQueueSnapshot;
  clearQueue(): AgentQueueSnapshot;
  whenIdle(): Promise<void>;
  close(): Promise<void>;
}

export interface RpcRuntimeLike {
  readonly sessionId: string;
  readonly session: RpcSessionLike;
  readonly services?: {
    checkpoint?(label?: string): Promise<unknown>;
    tree?(): readonly unknown[];
    rewind?(nodeId: string): Promise<void>;
    unrevert?(): Promise<void>;
    fork?(nodeId: string): Promise<void>;
  };
  readonly approvals?: {
    readonly pending: SessionApprovalRequest | undefined;
    resolve(decision: ApprovalDecision): void;
  };
  readonly rpcApprovals?: boolean;
  readonly rpcWrites?: {
    readonly pendingId: string | undefined;
    commit(id: string): void;
    dispose(): void;
  };
  dispose(): Promise<void>;
}

export interface FlavorRpcServerOptions {
  input: Readable;
  output: Writable;
  workspace: string;
  createRuntime(options: { workspace: string; output: (event: SessionOutput) => void }): Promise<RpcRuntimeLike>;
  onRecord?(kind: "command" | "response" | "output", payload: unknown): void | Promise<void>;
}

export class FlavorRpcServer {
  readonly #options: FlavorRpcServerOptions;
  #runtime: RpcRuntimeLike | undefined;
  #writeTail: Promise<void> = Promise.resolve();
  #closing = false;
  #lines: ReadlineInterface | undefined;

  constructor(options: FlavorRpcServerOptions) { this.#options = options; }

  async start(): Promise<void> {
    this.#runtime = await this.#options.createRuntime({
      workspace: this.#options.workspace,
      output: (event) => {
        const emitted = this.#emit({ type: "event", sessionId: this.#runtime?.sessionId, event }, "output");
        if (event.type === "exit") {
          // A memory rotation must let the launcher observe exit code 75. Keep
          // stdin itself open so the relaunched RPC child inherits the same
          // client connection from the supervising launcher.
          void emitted.finally(() => {
            this.#closing = true;
            this.#lines?.close();
          });
        }
      },
    });
    await this.#runtime.session.start();
    const lines = createInterface({ input: this.#options.input, crlfDelay: Infinity });
    this.#lines = lines;
    try {
      for await (const line of lines) {
        if (this.#closing) break;
        await this.#accept(line);
      }
    } finally {
      this.#lines = undefined;
      this.#runtime.rpcWrites?.dispose();
      await this.#runtime.session.close();
      await this.#runtime.dispose();
      await this.#writeTail;
    }
  }

  async #accept(line: string): Promise<void> {
    let input: unknown;
    try { input = JSON.parse(line); }
    catch {
      await this.#emit({ type: "error", code: "invalid_json", message: "Input is not valid JSON" }, "response");
      return;
    }
    const parsed = RpcCommandSchema.safeParse(input);
    if (!parsed.success) {
      await this.#emit({
        type: "error", code: "invalid_command", message: parsed.error.issues[0]?.message ?? "Invalid command",
      }, "response");
      return;
    }
    await this.#options.onRecord?.("command", parsed.data);
    try {
      await this.#dispatch(parsed.data);
    } catch (error) {
      await this.#emit({
        ...(parsed.data.id === undefined ? {} : { id: parsed.data.id }),
        type: "error",
        code: "runtime_error",
        message: message(error),
      }, "response");
    }
  }

  async #dispatch(command: RpcCommand): Promise<void> {
    const runtime = this.#runtime!;
    const respond = (data?: unknown) => this.#emit({
      ...(command.id === undefined ? {} : { id: command.id }),
      type: "response",
      command: command.type,
      success: true,
      ...(data === undefined ? {} : { data }),
    }, "response");
    if (command.type === "prompt") {
      await respond();
      void runtime.session.submit(command.message).catch((error) => this.#emit({
        type: "error", code: "runtime_error", message: message(error),
      }, "response"));
    } else if (command.type === "steer") {
      runtime.session.steer(command.message);
      await respond(runtime.session.queueSnapshot());
    } else if (command.type === "follow_up") {
      runtime.session.followUp(command.message);
      await respond(runtime.session.queueSnapshot());
    } else if (command.type === "abort") {
      await respond({ result: runtime.session.interrupt() });
    } else if (command.type === "get_queue") {
      await respond(runtime.session.queueSnapshot());
    } else if (command.type === "clear_queue") {
      await respond(runtime.session.clearQueue());
    } else if (command.type === "approval_decision") {
      const approvals = runtime.approvals;
      const approval = approvals?.pending;
      if (!runtime.rpcApprovals || approvals === undefined || approval === undefined) throw new Error("No approval request is pending");
      if (approval.id !== command.approvalId) throw new Error("Approval request is no longer active");
      approvals.resolve(command.decision);
      await respond();
    } else if (command.type === "write_commit") {
      const writes = runtime.rpcWrites;
      if (writes === undefined) throw new Error("Streamed writes are unavailable");
      if (writes.pendingId !== command.writeId) throw new Error("Streamed write is no longer awaiting commit");
      writes.commit(command.writeId);
      await respond();
    } else if (command.type === "get_state") {
      await respond({
        sessionId: runtime.sessionId,
        active: runtime.session.active,
        queue: runtime.session.queueSnapshot(),
        capabilities: { approvals: runtime.rpcApprovals === true, streamedWrites: runtime.rpcWrites !== undefined },
        ...(runtime.rpcApprovals && runtime.approvals?.pending !== undefined ? { approval: runtime.approvals.pending } : {}),
      });
    } else if (command.type === "checkpoint") {
      await respond(await required(runtime.services?.checkpoint, "checkpoint")(command.label));
    } else if (command.type === "get_tree") {
      await respond(required(runtime.services?.tree, "get_tree")());
    } else if (command.type === "rewind") {
      await required(runtime.services?.rewind, "rewind")(command.nodeId);
      await respond();
    } else if (command.type === "unrevert") {
      await required(runtime.services?.unrevert, "unrevert")();
      await respond();
    } else if (command.type === "fork") {
      await required(runtime.services?.fork, "fork")(command.nodeId);
      await respond();
    } else {
      this.#closing = true;
      await respond();
      this.#lines?.close();
    }
  }

  #emit(value: unknown, kind: "response" | "output"): Promise<void> {
    this.#writeTail = this.#writeTail.then(async () => {
      await this.#options.onRecord?.(kind, value);
      await new Promise<void>((resolvePromise, reject) => {
        this.#options.output.write(`${JSON.stringify(value)}\n`, (error) => error ? reject(error) : resolvePromise());
      });
    });
    return this.#writeTail;
  }
}

function required<T extends (...args: never[]) => unknown>(service: T | undefined, name: string): T {
  if (service === undefined) throw new Error(`RPC command ${name} is unavailable`);
  return service;
}
