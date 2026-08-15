import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chmod, lstat, mkdir, stat, writeFile } from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";

import { PalBrokerServer, PalBrokerState, isWindowsPipeAddress } from "../../src/pals/broker.js";
import { ensurePalBrokerRunning, runPalBroker } from "../../src/pals/broker-cli.js";
import { MAX_CONTROL_FRAME_BYTES } from "../../src/pals/protocol.js";

const A = "10000000-0000-4000-8000-000000000001";
const AUTH_TOKEN = "a".repeat(64);

function address(label: string): string {
  const suffix = `${process.pid}-${randomUUID()}`;
  return process.platform === "win32"
    ? `\\\\.\\pipe\\flavor-pals-${label}-${suffix}`
    : join(tmpdir(), `flavor-pals-${label}-${suffix}`, "pals.sock");
}

function connectRaw(socketAddress: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = new Socket();
    socket.once("error", reject);
    socket.connect(socketAddress, () => {
      socket.off("error", reject);
      resolve(socket);
    });
  });
}

function nextLine(socket: Socket): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      cleanup();
      resolve(JSON.parse(buffer.slice(0, newline)));
    };
    const onClose = () => {
      cleanup();
      reject(new Error("socket closed before a frame arrived"));
    };
    const cleanup = () => {
      socket.off("data", onData);
      socket.off("close", onClose);
    };
    socket.on("data", onData);
    socket.on("close", onClose);
  });
}

function request(socket: Socket, value: unknown): Promise<unknown> {
  const response = nextLine(socket);
  socket.write(`${JSON.stringify(value)}\n`);
  return response;
}

const openBrokers: PalBrokerServer[] = [];
const openSockets: Socket[] = [];

afterEach(async () => {
  for (const socket of openSockets.splice(0)) socket.destroy();
  await Promise.all(openBrokers.splice(0).map((broker) => broker.close()));
});

describe("PalBrokerServer transport", () => {
  it("cannot configure an inbound frame limit above the protocol ceiling", () => {
    expect(() => new PalBrokerServer({ address: address("frame-config"), maxFrameBytes: MAX_CONTROL_FRAME_BYTES + 1 }))
      .toThrow(/maxFrameBytes.*65536/i);
  });
  it("rejects unauthenticated and wrong-token sockets before register/list/send", async () => {
    const broker = new PalBrokerServer({ address: address("credential"), authToken: AUTH_TOKEN });
    openBrokers.push(broker);
    await broker.start();
    for (const authToken of [undefined, "b".repeat(64)]) {
      const socket = await connectRaw(broker.address);
      openSockets.push(socket);
      const response = await request(socket, {
        version: 1, type: "register", requestId: randomUUID(),
        ...(authToken === undefined ? {} : { authToken }),
        presence: {
          version: 1, id: A, alias: "app", projectPath: "/work/app",
          connectedAt: new Date().toISOString(), lastSeenAt: new Date().toISOString(),
        },
      });
      expect(response).toMatchObject({ type: "error", code: "authentication-failed" });
      await expect(request(socket, { version: 1, type: "list", requestId: randomUUID() }))
        .resolves.toMatchObject({ type: "error" });
    }
  });
  it("rejects forged sender fields and keeps the authenticated connection usable", async () => {
    const broker = new PalBrokerServer({ address: address("auth"), authToken: AUTH_TOKEN });
    openBrokers.push(broker);
    await broker.start();
    const socket = await connectRaw(broker.address);
    openSockets.push(socket);

    await request(socket, {
      version: 1,
      type: "register",
      requestId: randomUUID(),
      authToken: AUTH_TOKEN,
      presence: {
        version: 1,
        id: A,
        alias: "app",
        projectPath: "C:\\work\\app",
        connectedAt: new Date().toISOString(),
        lastSeenAt: new Date().toISOString(),
      },
    });
    const forgedId = randomUUID();
    const forged = await request(socket, {
      version: 1,
      type: "task",
      requestId: forgedId,
      messageId: randomUUID(),
      target: "app",
      goal: "do work",
      senderId: randomUUID(),
    });
    expect(forged).toMatchObject({ type: "error", requestId: forgedId, code: "invalid-request" });

    const listId = randomUUID();
    await expect(request(socket, { version: 1, type: "list", requestId: listId }))
      .resolves.toMatchObject({ type: "ok", requestId: listId, data: [expect.objectContaining({ id: A })] });
  });

  it("drops oversized and malformed clients without crashing healthy clients", async () => {
    const broker = new PalBrokerServer({ address: address("frames"), authToken: AUTH_TOKEN });
    openBrokers.push(broker);
    await broker.start();
    const bad = await connectRaw(broker.address);
    const healthy = await connectRaw(broker.address);
    openSockets.push(bad, healthy);

    bad.write(`${"x".repeat(MAX_CONTROL_FRAME_BYTES + 1)}\n`);
    await new Promise<void>((resolve) => bad.once("close", () => resolve()));
    healthy.write("{definitely invalid json}\n");
    await new Promise<void>((resolve) => healthy.once("close", () => resolve()));

    const replacement = await connectRaw(broker.address);
    openSockets.push(replacement);
    await request(replacement, {
      version: 1,
      type: "register",
      requestId: randomUUID(),
      authToken: AUTH_TOKEN,
      presence: {
        version: 1,
        id: A,
        alias: "healthy",
        projectPath: "C:\\work\\healthy",
        connectedAt: new Date().toISOString(),
        lastSeenAt: new Date().toISOString(),
      },
    });
    const requestId = randomUUID();
    await expect(request(replacement, { version: 1, type: "list", requestId }))
      .resolves.toMatchObject({ type: "ok", requestId, data: [expect.objectContaining({ id: A })] });
  });

  it.runIf(process.platform !== "win32")("removes only an exact stale Unix socket", async () => {
    const socketAddress = address("stale");
    await mkdir(join(socketAddress, ".."), { recursive: true, mode: 0o700 });
    const stale = spawn(process.execPath, ["-e", `require("node:net").createServer().listen(${JSON.stringify(socketAddress)},()=>process.stdout.write("ready"))`], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    await new Promise<void>((resolve, reject) => {
      stale.once("error", reject);
      stale.stdout.once("data", () => resolve());
    });
    stale.kill("SIGKILL");
    await new Promise<void>((resolve) => stale.once("exit", () => resolve()));
    expect((await lstat(socketAddress)).isSocket()).toBe(true);

    const broker = new PalBrokerServer({ address: socketAddress, platform: "darwin" });
    openBrokers.push(broker);
    await broker.start();
    expect((await lstat(socketAddress)).isSocket()).toBe(true);
    await broker.close();
    await expect(lstat(socketAddress)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.runIf(process.platform !== "win32")("refuses a second broker at a live Unix endpoint without disconnecting the first", async () => {
    const socketAddress = address("live-owner");
    const first = new PalBrokerServer({ address: socketAddress, platform: "darwin", authToken: AUTH_TOKEN });
    openBrokers.push(first);
    await first.start();
    const client = await connectRaw(socketAddress);
    openSockets.push(client);
    const second = new PalBrokerServer({ address: socketAddress, platform: "darwin", authToken: AUTH_TOKEN });
    await expect(second.start()).rejects.toThrow(/active|owned|use/i);
    await expect(request(client, {
      version: 1, type: "register", requestId: randomUUID(), authToken: AUTH_TOKEN,
      presence: { version: 1, id: A, alias: "app", projectPath: "/work/app", connectedAt: new Date().toISOString(), lastSeenAt: new Date().toISOString() },
    })).resolves.toMatchObject({ type: "ok" });
  });

  it.runIf(process.platform !== "win32")("refuses to unlink a non-socket at the Unix address", async () => {
    const socketAddress = address("regular-file");
    await mkdir(join(socketAddress, ".."), { recursive: true, mode: 0o700 });
    await writeFile(socketAddress, "keep me", "utf8");
    const broker = new PalBrokerServer({ address: socketAddress, platform: "darwin" });
    await expect(broker.start()).rejects.toThrow(/not a socket/i);
    expect(await lstat(socketAddress)).toMatchObject({ isFile: expect.any(Function) });
    await expect(lstat(`${socketAddress}.owner.lock`)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.runIf(process.platform !== "win32")("forces the exact Unix socket parent to user-only mode", async () => {
    const socketAddress = address("private-parent");
    const parent = join(socketAddress, "..");
    await mkdir(parent, { recursive: true });
    await chmod(parent, 0o777);
    const broker = new PalBrokerServer({ address: socketAddress, platform: "darwin" });
    openBrokers.push(broker);
    await broker.start();
    expect((await stat(parent)).mode & 0o777).toBe(0o700);
  });

  it("classifies Windows pipes without filesystem treatment on any host", () => {
    expect(isWindowsPipeAddress("\\\\.\\pipe\\flavor-code-pals", "win32")).toBe(true);
    expect(isWindowsPipeAddress("/tmp/pals.sock", "darwin")).toBe(false);
    expect(isWindowsPipeAddress("\\\\.\\pipe\\flavor-code-pals", "darwin")).toBe(false);
  });

  it("sweeps expired registrations and releases their authenticated sockets", async () => {
    let now = 1_000;
    const state = new PalBrokerState({ now: () => now, heartbeatTimeoutMs: 20 });
    const broker = new PalBrokerServer({ address: address("sweep"), state, authToken: AUTH_TOKEN });
    openBrokers.push(broker);
    await broker.start();
    const stale = await connectRaw(broker.address);
    openSockets.push(stale);
    const presence = {
      version: 1,
      id: A,
      alias: "app",
      projectPath: "C:\\work\\app",
      connectedAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
    };
    await request(stale, { version: 1, type: "register", requestId: randomUUID(), authToken: AUTH_TOKEN, presence });
    now += 21;
    broker.sweep();

    const replacement = await connectRaw(broker.address);
    openSockets.push(replacement);
    await expect(request(replacement, { version: 1, type: "register", requestId: randomUUID(), authToken: AUTH_TOKEN, presence }))
      .resolves.toMatchObject({ type: "ok", data: expect.objectContaining({ id: A }) });
  });
});

describe("broker lifecycle", () => {
  it("runs heartbeat sweeps and supports bounded idle shutdown", async () => {
    const runner = await runPalBroker({ address: address("runner"), sweepIntervalMs: 10, idleShutdownMs: 20 });
    await expect(runner.closed).resolves.toBeUndefined();
  });

  it("uses one injected starter when concurrent clients race to auto-start", async () => {
    const socketAddress = address("auto-start");
    let starts = 0;
    let broker: PalBrokerServer | undefined;
    const startBroker = async () => {
      starts += 1;
      broker = new PalBrokerServer({ address: socketAddress });
      openBrokers.push(broker);
      await broker.start();
    };

    await Promise.all([
      ensurePalBrokerRunning({ address: socketAddress, startBroker, timeoutMs: 1_000 }),
      ensurePalBrokerRunning({ address: socketAddress, startBroker, timeoutMs: 1_000 }),
    ]);
    expect(starts).toBe(1);
    expect(broker).toBeDefined();
  });
});
