import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import type { z } from "zod";

import {
  HookDecisionSchema,
  HookEventSchema,
  type HookDecision,
  type HookEvent,
  type HookEventName,
  type HookHandler,
  type HookHandlerOptions,
  type ShellHookHandler,
} from "./types.js";

interface RegisteredHandler {
  handler: HookHandler | ShellHookHandler;
  timeoutMs: number;
  failurePolicy: "error" | "allow" | "deny" | "ask";
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1_048_576;

export class HookBus {
  readonly #handlers = new Map<HookEventName, RegisteredHandler[]>();
  readonly #payloadSchemas = new Map<HookEventName, z.ZodType<Record<string, unknown>>>();

  registerPayloadSchema(type: HookEventName, schema: z.ZodType<Record<string, unknown>>): () => void {
    this.#payloadSchemas.set(type, schema);
    return () => {
      if (this.#payloadSchemas.get(type) === schema) this.#payloadSchemas.delete(type);
    };
  }

  on(type: HookEventName, handler: HookHandler | ShellHookHandler, options: HookHandlerOptions = {}): () => void {
    const shell = typeof handler !== "function" ? handler : undefined;
    const registered: RegisteredHandler = {
      handler,
      timeoutMs: options.timeoutMs ?? shell?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      failurePolicy: options.failurePolicy ?? shell?.failurePolicy ?? "error",
    };
    const handlers = this.#handlers.get(type) ?? [];
    handlers.push(registered);
    this.#handlers.set(type, handlers);
    return () => {
      const index = handlers.indexOf(registered);
      if (index >= 0) handlers.splice(index, 1);
    };
  }

  async emit(rawEvent: HookEvent): Promise<HookDecision> {
    let event = HookEventSchema.parse(rawEvent);
    event = { ...event, payload: this.#validatePayload(event.type, event.payload) } as HookEvent;
    let aggregate: HookDecision = { decision: "allow" };

    for (const registered of this.#handlers.get(event.type) ?? []) {
      let decision: HookDecision;
      try {
        decision = await this.#invoke(registered, event);
      } catch (error) {
        if (registered.failurePolicy === "error") throw error;
        decision = { decision: registered.failurePolicy, reason: `Hook failed: ${errorMessage(error)}` };
      }

      if (decision.updatedInput !== undefined) {
        const payload = this.#validatePayload(event.type, decision.updatedInput);
        event = HookEventSchema.parse({ ...event, payload });
        aggregate = { ...aggregate, updatedInput: event.payload };
      }
      if (decision.additionalContext !== undefined) {
        aggregate = {
          ...aggregate,
          additionalContext: [aggregate.additionalContext, decision.additionalContext].filter(Boolean).join("\n"),
        };
      }
      if (decision.decision === "deny") return mergeDecision(aggregate, decision);
      if (decision.decision === "ask") aggregate = mergeDecision(aggregate, decision);
    }
    return aggregate;
  }

  #validatePayload(type: HookEventName, payload: unknown): Record<string, unknown> {
    const schema = this.#payloadSchemas.get(type);
    return schema ? schema.parse(payload) : zodRecord(payload);
  }

  async #invoke(registered: RegisteredHandler, event: HookEvent): Promise<HookDecision> {
    const signal = AbortSignal.timeout(registered.timeoutMs);
    const invocation = typeof registered.handler === "function"
      ? Promise.resolve(registered.handler(event, signal))
      : runShellHandler(registered.handler, event, signal);
    const timeout = new Promise<never>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
    return HookDecisionSchema.parse(await Promise.race([invocation, timeout]));
  }
}

function runShellHandler(descriptor: ShellHookHandler, event: HookEvent, signal: AbortSignal): Promise<HookDecision> {
  return new Promise((resolve, reject) => {
    const child = spawn(descriptor.command, [...(descriptor.args ?? [])], {
      env: { ...process.env, ...descriptor.env },
      shell: false,
      detached: process.platform !== "win32",
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const maxOutputBytes = descriptor.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    let settled = false;
    const finishReject = (error: unknown) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      terminateProcessTree(child);
      reject(error);
    };
    const append = (stream: "stdout" | "stderr", chunk: Buffer | string) => {
      outputBytes += Buffer.byteLength(chunk);
      if (outputBytes > maxOutputBytes) {
        finishReject(new Error(`Shell hook output limit exceeded (${maxOutputBytes} bytes)`));
        return;
      }
      if (stream === "stdout") stdout += chunk.toString();
      else stderr += chunk.toString();
    };
    const onAbort = () => finishReject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => append("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => append("stderr", chunk));
    child.once("error", finishReject);
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      if (code !== 0) {
        reject(new Error(`Shell hook exited with code ${code}: ${stderr.trim()}`));
        return;
      }
      try { resolve(HookDecisionSchema.parse(JSON.parse(stdout))); }
      catch (error) { reject(error); }
    });
    child.stdin.end(JSON.stringify(event));
  });
}

function terminateProcessTree(child: ChildProcess): void {
  if (child.pid === undefined) return;
  if (process.platform === "win32") {
    const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
      stdio: "ignore",
      windowsHide: true,
    });
    killer.unref();
    child.kill();
    return;
  }
  try { process.kill(-child.pid, "SIGKILL"); }
  catch { child.kill("SIGKILL"); }
}

function mergeDecision(aggregate: HookDecision, decision: HookDecision): HookDecision {
  const merged: HookDecision = { ...aggregate, ...decision };
  if (aggregate.additionalContext !== undefined) merged.additionalContext = aggregate.additionalContext;
  if (aggregate.updatedInput !== undefined) merged.updatedInput = aggregate.updatedInput;
  else delete merged.updatedInput;
  return merged;
}

function zodRecord(payload: unknown): Record<string, unknown> {
  return HookEventSchema.options[0].shape.payload.parse(payload);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
