import { createHash } from "node:crypto";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

import { PalBrokerServer, type PalBrokerServerOptions } from "./broker.js";
import { acquirePalFileLock } from "./lifecycle.js";

export interface RunPalBrokerOptions extends PalBrokerServerOptions {
  sweepIntervalMs?: number;
  idleShutdownMs?: number;
}

export interface RunningPalBroker {
  server: PalBrokerServer;
  closed: Promise<void>;
  close: () => Promise<void>;
}

export interface EnsurePalBrokerOptions {
  address: string;
  timeoutMs?: number;
  retryDelayMs?: number;
  startBroker?: () => Promise<void>;
}

const startupAttempts = new Map<string, Promise<void>>();

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

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

function startupLockPath(address: string): string {
  const digest = createHash("sha256").update(address, "utf8").digest("hex").slice(0, 24);
  return join(tmpdir(), `flavor-code-pals-${digest}.startup.lock`);
}

async function spawnProductionBroker(address: string): Promise<void> {
  const entry = process.argv[1];
  if (entry === undefined) throw new Error("Cannot auto-start pals broker without a CLI entry point");
  const lockPath = startupLockPath(address);
  const lock = await acquirePalFileLock({ path: lockPath, endpointLive: () => canConnect(address) });
  if (lock === undefined) return;
  try {
    const child = spawn(process.execPath, [entry, "--pals-broker", address], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && !(await canConnect(address))) await delay(25);
  } finally {
    await lock.release();
  }
}

export async function runPalBroker(options: RunPalBrokerOptions): Promise<RunningPalBroker> {
  const server = new PalBrokerServer(options);
  await server.start();
  const sweepIntervalMs = options.sweepIntervalMs ?? 5_000;
  const idleShutdownMs = options.idleShutdownMs ?? 30_000;
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => { resolveClosed = resolve; });
  let closing: Promise<void> | undefined;
  const timer = setInterval(() => {
    server.sweep();
    if (server.connectionCount === 0 && Date.now() - server.lastActivityAt >= idleShutdownMs) void close();
  }, sweepIntervalMs);
  timer.unref?.();
  const close = (): Promise<void> => {
    if (closing !== undefined) return closing;
    closing = (async () => {
      clearInterval(timer);
      await server.close();
      resolveClosed();
    })();
    return closing;
  };
  return { server, closed, close };
}

export function ensurePalBrokerRunning(options: EnsurePalBrokerOptions): Promise<void> {
  const existing = startupAttempts.get(options.address);
  if (existing !== undefined) return existing;
  const attempt = ensureOnce(options).finally(() => startupAttempts.delete(options.address));
  startupAttempts.set(options.address, attempt);
  return attempt;
}

async function ensureOnce(options: EnsurePalBrokerOptions): Promise<void> {
  if (await canConnect(options.address)) return;
  await (options.startBroker ?? (() => spawnProductionBroker(options.address)))();
  const timeoutMs = options.timeoutMs ?? 5_000;
  const retryDelayMs = options.retryDelayMs ?? 25;
  const deadline = Date.now() + timeoutMs;
  do {
    if (await canConnect(options.address)) return;
    await delay(retryDelayMs);
  } while (Date.now() < deadline);
  throw new Error(`Timed out waiting for pals broker at '${options.address}'`);
}
