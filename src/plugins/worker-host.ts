import { realpath } from "node:fs/promises";
import { dirname } from "node:path";
import { Worker } from "node:worker_threads";

import type { SandboxedPluginResult, SandboxContributionKind, SandboxWorkerMessage } from "./sandbox-protocol.js";

export type { SandboxedPluginResult } from "./sandbox-protocol.js";

export interface PluginWorkerOptions {
  entryPath: string;
  pluginRoot?: string;
  pluginName: string;
  pluginVersion: string;
  config?: unknown;
  activationTimeoutMs?: number;
  invocationTimeoutMs?: number;
  maxOldSpaceMb?: number;
}

export interface SandboxedPluginSession {
  readonly result: SandboxedPluginResult;
  invoke<T>(kind: SandboxContributionKind, name: string, args: readonly unknown[]): Promise<T>;
  dispose(): Promise<void>;
}

const DEFAULT_ACTIVATION_TIMEOUT_MS = 10_000;
const DEFAULT_INVOCATION_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OLD_SPACE_MB = 128;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5_000;

export async function startPluginSandbox(options: PluginWorkerOptions): Promise<SandboxedPluginSession> {
  const entryPath = await realpath(options.entryPath);
  const pluginRoot = await realpath(options.pluginRoot ?? dirname(entryPath));
  const activationTimeoutMs = options.activationTimeoutMs ?? DEFAULT_ACTIVATION_TIMEOUT_MS;
  const invocationTimeoutMs = options.invocationTimeoutMs ?? DEFAULT_INVOCATION_TIMEOUT_MS;
  let configJson: string;
  try { configJson = JSON.stringify(options.config ?? {}); }
  catch (error) { throw new Error(`Plugin sandbox config is not serializable: ${String(error)}`); }
  const workerEntry = new URL(import.meta.url.endsWith(".ts") ? "./plugin-worker-entry.ts" : "./plugin-worker-entry.js", import.meta.url);
  const worker = new Worker(workerEntry, {
    workerData: { entryPath, pluginRoot, pluginName: options.pluginName, pluginVersion: options.pluginVersion, configJson },
    execArgv: ["--experimental-vm-modules", "--no-warnings"],
    resourceLimits: {
      maxOldGenerationSizeMb: options.maxOldSpaceMb ?? DEFAULT_MAX_OLD_SPACE_MB,
      maxYoungGenerationSizeMb: 16,
      codeRangeSizeMb: 16,
      stackSizeMb: 4,
    },
  });

  let closed = false;
  let nextId = 1;
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: unknown): void; timer: ReturnType<typeof setTimeout> }>();
  let disposeResolve: (() => void) | undefined;
  let disposeReject: ((error: unknown) => void) | undefined;
  let failWorker!: (error: unknown) => void;

  const ready = await new Promise<SandboxedPluginResult>((resolveReady, rejectReady) => {
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      closed = true;
      void worker.terminate();
      rejectReady(new Error(`Plugin activation sandbox timed out after ${activationTimeoutMs}ms`));
    }, activationTimeoutMs);

    const fail = (error: unknown): void => {
      if (closed && settled) return;
      closed = true;
      clearTimeout(timer);
      for (const request of pending.values()) { clearTimeout(request.timer); request.reject(error); }
      pending.clear();
      disposeReject?.(error);
      if (!settled) { settled = true; rejectReady(error); }
      void worker.terminate();
    };
    failWorker = fail;

    worker.on("message", (raw: unknown) => {
      if (!isWorkerMessage(raw)) { fail(new Error("Plugin sandbox sent an invalid protocol message")); return; }
      const message = raw;
      if (message.type === "fatal") { fail(new Error(message.error)); return; }
      if (message.type === "ready") {
        if (settled || !isSandboxResult(message.result)) { fail(new Error("Plugin sandbox sent an invalid or duplicate ready message")); return; }
        settled = true;
        clearTimeout(timer);
        resolveReady(message.result);
        return;
      }
      if (!settled) { fail(new Error(`Plugin sandbox sent ${message.type} before ready`)); return; }
      if (message.type === "response") {
        const request = pending.get(message.id);
        if (request === undefined) { fail(new Error("Plugin sandbox sent a response for an unknown request")); return; }
        pending.delete(message.id);
        clearTimeout(request.timer);
        if (message.ok) {
          try { request.resolve(JSON.parse(message.valueJson) as unknown); }
          catch { fail(new Error("Plugin sandbox returned invalid JSON")); }
        } else request.reject(new Error(message.error));
        return;
      }
      if (message.type === "disposed") {
        closed = true;
        disposeResolve?.();
        void worker.terminate();
      }
    });
    worker.once("error", fail);
    worker.once("exit", (code) => { if (!closed) fail(new Error(`Plugin worker exited with code ${code}`)); });
  });

  return {
    result: ready,
    invoke<T>(kind: SandboxContributionKind, name: string, args: readonly unknown[]): Promise<T> {
      if (closed) return Promise.reject(new Error("Plugin sandbox is closed"));
      let argsJson: string;
      try { argsJson = JSON.stringify(args); }
      catch (error) { return Promise.reject(new Error(`Plugin sandbox arguments are not serializable: ${String(error)}`)); }
      const id = nextId++;
      return new Promise<T>((resolveInvoke, rejectInvoke) => {
        const timer = setTimeout(() => {
          const error = new Error(`Plugin sandbox invocation timed out after ${invocationTimeoutMs}ms`);
          failWorker(error);
        }, invocationTimeoutMs);
        pending.set(id, { resolve: (value) => resolveInvoke(value as T), reject: rejectInvoke, timer });
        worker.postMessage({ type: "invoke", id, kind, name, argsJson });
      });
    },
    dispose(): Promise<void> {
      if (closed) return Promise.resolve();
      return new Promise<void>((resolveDispose, rejectDispose) => {
        const timer = setTimeout(() => {
          const error = new Error(`Plugin sandbox shutdown timed out after ${DEFAULT_SHUTDOWN_TIMEOUT_MS}ms`);
          failWorker(error);
        }, DEFAULT_SHUTDOWN_TIMEOUT_MS);
        disposeResolve = () => { clearTimeout(timer); resolveDispose(); };
        disposeReject = (error) => { clearTimeout(timer); rejectDispose(error); };
        worker.postMessage({ type: "shutdown" });
      });
    },
  };
}

export async function runPluginInSandbox(options: PluginWorkerOptions): Promise<SandboxedPluginResult> {
  try {
    const session = await startPluginSandbox(options);
    try { return session.result; }
    finally { await session.dispose(); }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (/timed out/i.test(detail)) throw error;
    return {
      ok: false,
      name: options.pluginName,
      version: options.pluginVersion,
      registeredTools: [], registeredCommands: [], registeredHooks: [], registeredSkillRoots: [], registeredModelAdapters: [],
      contributions: { commands: [], tools: [], hooks: [], skillRoots: [], modelAdapters: [] },
      error: detail,
    };
  }
}

function isWorkerMessage(value: unknown): value is SandboxWorkerMessage {
  if (typeof value !== "object" || value === null || !("type" in value)) return false;
  const type = (value as { type?: unknown }).type;
  if (type === "disposed") return true;
  if (type === "fatal") return typeof (value as { error?: unknown }).error === "string";
  if (type === "ready") return "result" in value;
  if (type !== "response") return false;
  const response = value as { id?: unknown; ok?: unknown; valueJson?: unknown; error?: unknown };
  return Number.isSafeInteger(response.id) && typeof response.ok === "boolean"
    && (response.ok ? typeof response.valueJson === "string" : typeof response.error === "string");
}

function isSandboxResult(value: unknown): value is SandboxedPluginResult {
  if (typeof value !== "object" || value === null) return false;
  const result = value as Partial<SandboxedPluginResult>;
  if (!(result.ok === true && typeof result.name === "string" && typeof result.version === "string"
    && Array.isArray(result.registeredTools) && result.registeredTools.every((item) => typeof item === "string")
    && Array.isArray(result.registeredCommands) && result.registeredCommands.every((item) => typeof item === "string")
    && Array.isArray(result.registeredHooks) && result.registeredHooks.every((item) => typeof item === "string")
    && Array.isArray(result.registeredSkillRoots) && result.registeredSkillRoots.every((item) => typeof item === "string")
    && Array.isArray(result.registeredModelAdapters) && result.registeredModelAdapters.every((item) => typeof item === "string")
    && typeof result.contributions === "object" && result.contributions !== null)) return false;
  const contributions = result.contributions;
  const named = (item: unknown): item is { name: string } => typeof item === "object" && item !== null
    && typeof (item as { name?: unknown }).name === "string";
  if (!Array.isArray(contributions.commands) || !contributions.commands.every((item) => named(item)
    && (item.description === undefined || typeof item.description === "string"))) return false;
  if (!Array.isArray(contributions.tools) || !contributions.tools.every((item) => named(item)
    && typeof item.toolName === "string" && typeof item.description === "string"
    && (item.modelInputSchema === undefined || (typeof item.modelInputSchema === "object" && item.modelInputSchema !== null))
    && (item.readOnly === undefined || typeof item.readOnly === "boolean"))) return false;
  if (!Array.isArray(contributions.hooks) || !contributions.hooks.every(named)) return false;
  if (!Array.isArray(contributions.skillRoots) || !contributions.skillRoots.every((item) => named(item) && typeof item.root === "string")) return false;
  if (!Array.isArray(contributions.modelAdapters) || !contributions.modelAdapters.every(named)) return false;
  const same = (left: readonly string[], right: readonly { name: string }[]) => left.length === right.length
    && left.every((name, index) => name === right[index]?.name);
  return same(result.registeredCommands, contributions.commands) && same(result.registeredTools, contributions.tools)
    && same(result.registeredHooks, contributions.hooks) && same(result.registeredSkillRoots, contributions.skillRoots)
    && same(result.registeredModelAdapters, contributions.modelAdapters);
}
