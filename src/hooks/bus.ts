import { spawn } from "node:child_process";

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

export class HookBus {
  readonly #handlers = new Map<HookEventName, RegisteredHandler[]>();

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
        event = HookEventSchema.parse({ ...event, payload: decision.updatedInput });
        aggregate = { ...aggregate, updatedInput: event.payload };
      }
      if (decision.additionalContext !== undefined) {
        aggregate = {
          ...aggregate,
          additionalContext: [aggregate.additionalContext, decision.additionalContext].filter(Boolean).join("\n"),
        };
      }
      if (decision.decision === "deny") return { ...aggregate, ...decision, updatedInput: aggregate.updatedInput };
      if (decision.decision === "ask") aggregate = { ...aggregate, ...decision, updatedInput: aggregate.updatedInput };
    }
    return aggregate;
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
      signal,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => {
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
