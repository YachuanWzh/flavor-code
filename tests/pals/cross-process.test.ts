import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { build } from "esbuild";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { PalBrokerServer } from "../../src/pals/broker.js";

interface ChildEvent {
  type: string;
  commandId?: string;
  [key: string]: unknown;
}

const TEST_TIMEOUT_MS = 15_000;
const fixtureSource = resolve("tests/pals/fixtures/pal-process.ts");
const fixtureDirectory = join(tmpdir(), `flavor-pals-cross-process-${process.pid}-${randomUUID()}`);
const fixtureBundle = join(fixtureDirectory, "pal-process.mjs");

function uniqueAddress(): string {
  const suffix = `${process.pid}-${randomUUID()}`;
  return process.platform === "win32"
    ? `\\\\.\\pipe\\flavor-pals-acceptance-${suffix}`
    : join(fixtureDirectory, `${suffix}.sock`);
}

class FixturePeer {
  readonly process: ChildProcessWithoutNullStreams;
  readonly events: ChildEvent[] = [];
  readonly stderr: string[] = [];
  #buffer = "";
  #waiters = new Set<() => void>();

  constructor(address: string, id: string, alias: string) {
    this.process = spawn(process.execPath, [fixtureBundle, address, id, alias, join(fixtureDirectory, alias), fixtureDirectory], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.process.stdout.setEncoding("utf8");
    this.process.stdout.on("data", (chunk: string) => {
      this.#buffer += chunk;
      while (true) {
        const newline = this.#buffer.indexOf("\n");
        if (newline < 0) break;
        const line = this.#buffer.slice(0, newline);
        this.#buffer = this.#buffer.slice(newline + 1);
        if (line.length > 0) this.events.push(JSON.parse(line) as ChildEvent);
        for (const wake of this.#waiters) wake();
      }
    });
    this.process.stderr.setEncoding("utf8");
    this.process.stderr.on("data", (chunk: string) => this.stderr.push(chunk));
    this.process.once("exit", () => {
      for (const wake of this.#waiters) wake();
    });
  }

  async waitFor(predicate: (event: ChildEvent) => boolean, timeoutMs = TEST_TIMEOUT_MS): Promise<ChildEvent> {
    const deadline = Date.now() + timeoutMs;
    while (true) {
      const match = this.events.find(predicate);
      if (match !== undefined) return match;
      if (this.process.exitCode !== null) {
        throw new Error(`Fixture exited ${this.process.exitCode}: ${this.stderr.join("")}`);
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`Timed out waiting for fixture event; stderr=${this.stderr.join("")}`);
      await new Promise<void>((resolveWait) => {
        const wake = () => {
          clearTimeout(timer);
          this.#waiters.delete(wake);
          resolveWait();
        };
        const timer = setTimeout(wake, remaining);
        this.#waiters.add(wake);
      });
    }
  }

  async command(type: string, fields: Record<string, unknown> = {}): Promise<ChildEvent> {
    const commandId = randomUUID();
    this.process.stdin.write(`${JSON.stringify({ type, commandId, ...fields })}\n`);
    return this.waitFor((event) => event.type === "result" && event.commandId === commandId);
  }

  async close(): Promise<void> {
    if (this.process.exitCode !== null) return;
    await this.command("close").catch(() => undefined);
    if (this.process.exitCode !== null) return;
    await new Promise<void>((resolveExit, reject) => {
      const timer = setTimeout(() => reject(new Error("Fixture did not exit after close")), 2_000);
      this.process.once("exit", () => {
        clearTimeout(timer);
        resolveExit();
      });
    }).catch((error) => {
      this.process.kill();
      throw error;
    });
  }
}

const brokers: PalBrokerServer[] = [];
const peers: FixturePeer[] = [];

async function waitUntil<T>(probe: () => Promise<T | undefined>, timeoutMs = TEST_TIMEOUT_MS): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const result = await probe();
      if (result !== undefined) return result;
    } catch (error) {
      lastError = error;
    }
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 10));
  }
  throw new Error(`Condition was not met before timeout${lastError === undefined ? "" : `: ${String(lastError)}`}`);
}

function countEvents(peer: FixturePeer, type: string, fields: Record<string, unknown> = {}): number {
  return peer.events.filter((event) => event.type === type
    && Object.entries(fields).every(([key, value]) => event[key] === value)).length;
}

class BrokerFixture {
  readonly process: ChildProcessWithoutNullStreams;
  readonly events: ChildEvent[] = [];
  readonly stderr: string[] = [];
  #buffer = "";
  #waiters = new Set<() => void>();

  constructor(address: string) {
    this.process = spawn(process.execPath, [fixtureBundle, "--ensure-broker", address, fixtureDirectory], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.process.stdout.setEncoding("utf8");
    this.process.stdout.on("data", (chunk: string) => {
      this.#buffer += chunk;
      while (true) {
        const newline = this.#buffer.indexOf("\n");
        if (newline < 0) break;
        const line = this.#buffer.slice(0, newline);
        this.#buffer = this.#buffer.slice(newline + 1);
        if (line.length > 0) this.events.push(JSON.parse(line) as ChildEvent);
        for (const wake of this.#waiters) wake();
      }
    });
    this.process.stderr.setEncoding("utf8");
    this.process.stderr.on("data", (chunk: string) => this.stderr.push(chunk));
    this.process.once("exit", () => { for (const wake of this.#waiters) wake(); });
  }

  async waitFor(predicate: (event: ChildEvent) => boolean, timeoutMs = TEST_TIMEOUT_MS): Promise<ChildEvent> {
    const deadline = Date.now() + timeoutMs;
    while (true) {
      const match = this.events.find(predicate);
      if (match !== undefined) return match;
      if (this.process.exitCode !== null) throw new Error(`Broker fixture exited ${this.process.exitCode}: ${this.stderr.join("")}`);
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`Timed out waiting for broker fixture; stderr=${this.stderr.join("")}`);
      await new Promise<void>((resolveWait) => {
        const wake = () => { clearTimeout(timer); this.#waiters.delete(wake); resolveWait(); };
        const timer = setTimeout(wake, remaining);
        this.#waiters.add(wake);
      });
    }
  }

  async close(): Promise<void> {
    if (this.process.exitCode !== null) return;
    this.process.stdin.write(`${JSON.stringify({ type: "close" })}\n`);
    await this.waitFor((event) => event.type === "closed", 2_000);
    await waitUntil(async () => this.process.exitCode === null ? undefined : this.process.exitCode, 2_000);
  }
}

const brokerFixtures: BrokerFixture[] = [];

beforeAll(async () => {
  await mkdir(fixtureDirectory, { recursive: true });
  await build({
    entryPoints: [fixtureSource],
    outfile: fixtureBundle,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    sourcemap: "inline",
    banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
  });
});

afterEach(async () => {
  await Promise.all(peers.splice(0).map((peer) => peer.close()));
  await Promise.all(brokers.splice(0).map((broker) => broker.close()));
  await Promise.all(brokerFixtures.splice(0).map((fixture) => fixture.close()));
});

afterAll(async () => {
  await rm(fixtureDirectory, { recursive: true, force: true });
});

describe("pals cross-process acceptance", () => {
  it("lists, routes bidirectionally, starts safe session work, scales to a third peer, and closes cleanly", async () => {
    const address = uniqueAddress();
    const broker = new PalBrokerServer({ address, authHome: fixtureDirectory });
    brokers.push(broker);
    await broker.start();

    const ids = [randomUUID(), randomUUID(), randomUUID()];
    const a = new FixturePeer(address, ids[0]!, "A");
    const b = new FixturePeer(address, ids[1]!, "B");
    const c = new FixturePeer(address, ids[2]!, "C");
    peers.push(a, b, c);
    await Promise.all([a.waitFor((event) => event.type === "ready"), b.waitFor((event) => event.type === "ready"), c.waitFor((event) => event.type === "ready")]);

    const listed = await a.command("list");
    expect(new Set((listed.pals as Array<{ id: string }>).map(({ id }) => id))).toEqual(new Set(ids));

    const unicodeGoal = "你好，B：请更新 API ✅";
    const outboundId = randomUUID();
    await expect(a.command("send", { target: "B", message: unicodeGoal, messageId: outboundId }))
      .resolves.toMatchObject({ receipt: { status: "delivered", recipientIds: [ids[1]] } });
    const received = await b.waitFor((event) => event.type === "task-received" && event.messageId === outboundId);
    expect(received).toMatchObject({ senderId: ids[0], senderAlias: "A", messageId: outboundId, goal: unicodeGoal });
    const modelRun = await b.waitFor((event) => event.type === "model-run" && event.messageId === outboundId);
    expect(modelRun.prompt).toEqual(expect.stringContaining(JSON.stringify(unicodeGoal)));
    expect(modelRun.prompt).not.toMatch(/^\s*\//);
    const workStarted = await b.waitFor((event) => event.type === "work-started" && event.messageId === outboundId);
    expect(b.events.indexOf(workStarted)).toBeGreaterThan(b.events.indexOf(modelRun));

    const replyId = randomUUID();
    await b.command("send", { target: "A", message: "收到，开始处理", messageId: replyId });
    await expect(a.waitFor((event) => event.type === "task-received" && event.messageId === replyId))
      .resolves.toMatchObject({ senderId: ids[1], senderAlias: "B", goal: "收到，开始处理" });

    const thirdId = randomUUID();
    await a.command("send", { target: "C", message: "third peer route", messageId: thirdId });
    await expect(c.waitFor((event) => event.type === "task-received" && event.messageId === thirdId))
      .resolves.toMatchObject({ senderAlias: "A", goal: "third peer route" });

    await b.close();
    peers.splice(peers.indexOf(b), 1);
    const afterDisconnect = await a.command("list");
    expect((afterDisconnect.pals as Array<{ id: string }>).map(({ id }) => id)).not.toContain(ids[1]);
    expect(broker.connectionCount).toBe(2);
  }, 30_000);

  it("runs PLAN, early READY, START, parallel session work, assertions, integration, and END across three OS processes", async () => {
    const address = uniqueAddress();
    const firstBroker = new PalBrokerServer({ address, authHome: fixtureDirectory });
    brokers.push(firstBroker);
    await firstBroker.start();

    const [aId, bId, cId] = [randomUUID(), randomUUID(), randomUUID()];
    const a = new FixturePeer(address, aId!, "A");
    const b = new FixturePeer(address, bId!, "B");
    const c = new FixturePeer(address, cId!, "C");
    peers.push(a, b, c);
    await Promise.all([a, b, c].map((peer) => peer.waitFor((event) => event.type === "ready")));

    const coWorkId = randomUUID();
    const goal = "B upgrades its API while A adapts to the agreed contract";
    const participants = [
      { palId: aId!, required: true },
      { palId: bId!, required: true },
      { palId: cId!, required: false },
    ];
    await a.command("cowork-propose", { coWorkId, goal, participants });
    for (const peer of [a, b, c]) {
      await peer.waitFor((event) => event.type === "cowork-wire" && event.coWorkId === coWorkId && event.action === "PROPOSE");
    }
    for (const peer of [a, b]) {
      await expect(peer.waitFor((event) => event.type === "model-run" && event.coWorkId === coWorkId && event.phase === "planning"))
        .resolves.toMatchObject({ permissionMode: "plan", mutationExecutions: 0 });
    }
    await c.command("barrier");
    expect(await c.command("stats")).toMatchObject({ permissionMode: "default", workStarts: 0, mutationExecutions: 0 });

    const plan = {
      version: 1,
      coWorkId,
      epoch: 1,
      goal,
      participants,
      tasks: [
        { id: "b-api", assigneeId: bId!, description: "Implement shared contract upgradeApi(input): Result and verify it", dependsOn: [] },
        { id: "a-adapter", assigneeId: aId!, description: "Adapt A to the shared upgradeApi Result contract without legacy fallback", dependsOn: [] },
      ],
    };
    const planned = await a.command("cowork-plan", { plan });
    expect(planned.snapshot).toMatchObject({ phase: "planning", epoch: 1 });
    const planHash = (planned.snapshot as { planHash: string }).planHash;
    expect(planHash).toMatch(/^[a-f0-9]{64}$/);
    await Promise.all([a, b, c].map((peer) => peer.waitFor((event) => event.type === "cowork-wire"
      && event.coWorkId === coWorkId && event.action === "PLAN" && event.planHash === planHash)));

    const early = await a.command("cowork-ready", { coWorkId, epoch: 1, planHash });
    expect(early.snapshot).toMatchObject({ phase: "planning", readyParticipantIds: [aId] });
    expect(countEvents(a, "cowork-wire", { coWorkId, action: "START" })).toBe(0);

    const barrier = await b.command("cowork-ready", { coWorkId, epoch: 1, planHash });
    expect(barrier.snapshot).toMatchObject({ phase: "running" });
    const starts = await Promise.all([a, b, c].map((peer) => peer.waitFor((event) => event.type === "cowork-wire"
      && event.coWorkId === coWorkId && event.action === "START")));
    expect(starts).toHaveLength(3);
    await Promise.all([a, b].map((peer) => peer.waitFor((event) => event.type === "work-started" && event.coWorkId === coWorkId)));
    expect(countEvents(a, "cowork-wire", { coWorkId, action: "START" })).toBe(1);
    expect(countEvents(b, "cowork-wire", { coWorkId, action: "START" })).toBe(1);
    expect(countEvents(c, "cowork-wire", { coWorkId, action: "START" })).toBe(1);
    for (const peer of [a, b]) {
      const stats = await peer.command("stats");
      expect(stats).toMatchObject({ workStarts: 1, workCompletions: 0, mutationExecutions: 0, permissionMode: "default" });
    }

    await Promise.all([a, b, c].map((peer) => peer.command("release-work", { coWorkId })));
    await Promise.all([a, b, c].map((peer) => peer.command("idle")));
    await a.command("cowork-complete", { coWorkId, epoch: 1, planHash, passed: true, detail: "A adapter tests passed" });
    const verifying = await b.command("cowork-complete", { coWorkId, epoch: 1, planHash, passed: true, detail: "B API tests passed" });
    expect(verifying.snapshot).toMatchObject({
      phase: "verifying",
      completedParticipantIds: expect.arrayContaining([aId, bId]),
      completionAssertions: expect.arrayContaining([
        { participantId: aId, passed: true, detail: "A adapter tests passed" },
        { participantId: bId, passed: true, detail: "B API tests passed" },
      ]),
    });

    const integrated = await a.command("cowork-integrate", {
      coWorkId, epoch: 1, planHash, passed: true, evidence: "cross-project contract verification passed",
    });
    expect(integrated.snapshot).toMatchObject({ phase: "completed", integration: { passed: true } });
    await Promise.all([a, b, c].map((peer) => peer.waitFor((event) => event.type === "cowork-wire"
      && event.coWorkId === coWorkId && event.action === "END")));
    await Promise.all([a, b, c].map((peer) => peer.command("barrier")));
    for (const peer of [a, b, c]) expect(countEvents(peer, "cowork-wire", { coWorkId, action: "END" })).toBe(1);

    const reconnectMessageId = randomUUID();
    await a.command("send", { target: "B", message: "survives reconnect without replay", messageId: reconnectMessageId });
    await b.waitFor((event) => event.type === "task-received" && event.messageId === reconnectMessageId);
    await b.command("idle");
    expect(countEvents(b, "task-received", { messageId: reconnectMessageId })).toBe(1);

    await firstBroker.close();
    const restartedBroker = new PalBrokerServer({ address, authHome: fixtureDirectory });
    brokers.push(restartedBroker);
    await restartedBroker.start();
    await waitUntil(async () => {
      const result = await a.command("list");
      if (result.error !== undefined) return undefined;
      const ids = (result.pals as Array<{ id: string }>).map(({ id }) => id);
      return ids.length === 3 ? ids : undefined;
    });
    for (const peer of [a, b, c]) {
      expect(countEvents(peer, "cowork-wire", { coWorkId, action: "START" })).toBe(1);
      expect(countEvents(peer, "cowork-wire", { coWorkId, action: "END" })).toBe(1);
    }
    expect(countEvents(b, "task-received", { messageId: reconnectMessageId })).toBe(1);
  }, 45_000);

  it("broadcasts CANCEL as a distinct terminal event, restores planning permission, and never starts stale work", async () => {
    const address = uniqueAddress();
    const broker = new PalBrokerServer({ address, authHome: fixtureDirectory });
    brokers.push(broker);
    await broker.start();
    const [aId, bId] = [randomUUID(), randomUUID()];
    const a = new FixturePeer(address, aId!, "A");
    const b = new FixturePeer(address, bId!, "B");
    peers.push(a, b);
    await Promise.all([a, b].map((peer) => peer.waitFor((event) => event.type === "ready")));

    const coWorkId = randomUUID();
    await a.command("cowork-propose", {
      coWorkId,
      goal: "cancel before execution",
      participants: [{ palId: aId!, required: true }, { palId: bId!, required: true }],
    });
    await Promise.all([a, b].map((peer) => peer.waitFor((event) => event.type === "model-run"
      && event.coWorkId === coWorkId && event.phase === "planning" && event.permissionMode === "plan")));
    const cancelled = await a.command("cowork-cancel", { coWorkId, reason: "requirements changed" });
    expect(cancelled.snapshot).toMatchObject({ phase: "cancelled" });
    await Promise.all([a, b].map((peer) => peer.waitFor((event) => event.type === "cowork-wire"
      && event.coWorkId === coWorkId && event.action === "CANCEL")));
    await Promise.all([a, b].map((peer) => peer.command("barrier")));
    for (const peer of [a, b]) {
      expect(await peer.command("stats")).toMatchObject({ permissionMode: "default", workStarts: 0, mutationExecutions: 0 });
      expect(countEvents(peer, "cowork-wire", { coWorkId, action: "CANCEL" })).toBe(1);
      expect(countEvents(peer, "cowork-wire", { coWorkId, action: "START" })).toBe(0);
      expect(countEvents(peer, "cowork-wire", { coWorkId, action: "END" })).toBe(0);
    }
  }, 30_000);

  it("runs a sole-required lifecycle while an optional observer receives events but cannot mutate barriers", async () => {
    const address = uniqueAddress();
    const broker = new PalBrokerServer({ address, authHome: fixtureDirectory });
    brokers.push(broker);
    await broker.start();
    const [aId, observerId] = [randomUUID(), randomUUID()];
    const a = new FixturePeer(address, aId!, "A");
    const observer = new FixturePeer(address, observerId!, "observer");
    peers.push(a, observer);
    await Promise.all([a, observer].map((peer) => peer.waitFor((event) => event.type === "ready")));

    const coWorkId = randomUUID();
    const goal = "A ships while observer follows ordered state";
    const participants = [{ palId: aId!, required: true }, { palId: observerId!, required: false }];
    const proposed = await a.command("cowork-propose", { coWorkId, goal, participants });
    expect(proposed.snapshot).toMatchObject({ phase: "planning", integrationOwnerId: aId });
    await Promise.all([a, observer].map((peer) => peer.waitFor((event) => event.type === "cowork-wire"
      && event.coWorkId === coWorkId && event.action === "PROPOSE")));

    const plan = {
      version: 1, coWorkId, epoch: 1, goal, participants,
      tasks: [{ id: "a-work", assigneeId: aId!, description: "implement and verify", dependsOn: [] }],
    };
    const planned = await a.command("cowork-plan", { plan });
    const planHash = (planned.snapshot as { planHash: string }).planHash;
    const observerReady = await observer.command("cowork-ready", { coWorkId, epoch: 1, planHash });
    expect(observerReady.error).toMatch(/observer/i);

    await expect(a.command("cowork-ready", { coWorkId, epoch: 1, planHash }))
      .resolves.toMatchObject({ snapshot: { phase: "running" } });
    await Promise.all([a, observer].map((peer) => peer.waitFor((event) => event.type === "cowork-wire"
      && event.coWorkId === coWorkId && event.action === "START")));
    await a.waitFor((event) => event.type === "work-started" && event.coWorkId === coWorkId);
    await observer.command("barrier");
    expect(await observer.command("stats")).toMatchObject({ workStarts: 0, mutationExecutions: 0 });

    const observerComplete = await observer.command("cowork-complete", {
      coWorkId, epoch: 1, planHash, passed: false, detail: "force failure",
    });
    expect(observerComplete.error).toMatch(/observer/i);
    await a.command("release-work", { coWorkId });
    await a.command("idle");
    await expect(a.command("cowork-complete", {
      coWorkId, epoch: 1, planHash, passed: true, detail: "A tests passed",
    })).resolves.toMatchObject({ snapshot: { phase: "verifying" } });
    await expect(a.command("cowork-integrate", {
      coWorkId, epoch: 1, planHash, passed: true, evidence: "integration passed",
    })).resolves.toMatchObject({ snapshot: { phase: "completed" } });
    await Promise.all([a, observer].map((peer) => peer.waitFor((event) => event.type === "cowork-wire"
      && event.coWorkId === coWorkId && event.action === "END")));
  }, 30_000);

  it("lets concurrent real processes ensure one broker owns a unique endpoint", async () => {
    const address = uniqueAddress();
    const first = new BrokerFixture(address);
    const second = new BrokerFixture(address);
    brokerFixtures.push(first, second);
    const ready = await Promise.all([first, second].map((fixture) => fixture.waitFor((event) => event.type === "broker-ready")));
    expect(ready.filter((event) => event.owner === true)).toHaveLength(1);

    const peer = new FixturePeer(address, randomUUID(), "race-client");
    peers.push(peer);
    await peer.waitFor((event) => event.type === "ready");
    await expect(peer.command("list")).resolves.toMatchObject({ pals: [expect.objectContaining({ alias: "race-client" })] });
  }, 30_000);
});
