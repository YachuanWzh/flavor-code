import { randomUUID } from "node:crypto";
import { createServer, Socket, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { PalBrokerServer, canonicalPlanHash } from "../../src/pals/broker.js";
import { PalClient } from "../../src/pals/client.js";
import type { BrokerEvent, DeliveryReceipt, PalPresence } from "../../src/pals/protocol.js";

const A = "10000000-0000-4000-8000-000000000001";
const B = "10000000-0000-4000-8000-000000000002";
const AUTH_TOKEN = "a".repeat(64);

function address(label: string): string {
  const suffix = `${process.pid}-${randomUUID()}`;
  return process.platform === "win32"
    ? `\\\\.\\pipe\\flavor-pals-${label}-${suffix}`
    : join(tmpdir(), `flavor-pals-${label}-${suffix}`, "pals.sock");
}

function registration(id: string, alias: string): { id: string; alias: string; projectPath: string } {
  return { id, alias, projectPath: process.platform === "win32" ? `C:\\work\\${alias}` : `/work/${alias}` };
}

function waitForEvent(client: PalClient, predicate: (event: BrokerEvent) => boolean): Promise<BrokerEvent> {
  return new Promise((resolve) => {
    const unsubscribe = client.subscribe((event) => {
      if (!predicate(event)) return;
      unsubscribe();
      resolve(event);
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

const brokers: PalBrokerServer[] = [];
const clients: PalClient[] = [];
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await Promise.all(brokers.splice(0).map((broker) => broker.close()));
  await Promise.all(servers.splice(0).map((server) => closeServer(server)));
  vi.useRealTimers();
});

describe("PalClient over local IPC", () => {
  it("registers two pals, lists them, and routes tasks in both directions", async () => {
    const broker = new PalBrokerServer({ address: address("roundtrip") });
    brokers.push(broker);
    await broker.start();
    const a = new PalClient({ address: broker.address, registration: registration(A, "app"), heartbeatIntervalMs: 50 });
    const b = new PalClient({ address: broker.address, registration: registration(B, "api"), heartbeatIntervalMs: 50 });
    clients.push(a, b);
    await Promise.all([a.start(), b.start()]);

    const listed = await a.list();
    expect(listed.map((pal: PalPresence) => [pal.id, pal.alias])).toEqual([[A, "app"], [B, "api"]]);

    const aMessageId = randomUUID();
    const receivedByB = waitForEvent(b, (event) => event.type === "task-event" && event.messageId === aMessageId);
    const aReceipt = await a.sendTask("api", "change the API; /chat is plain text here", aMessageId);
    await expect(receivedByB).resolves.toMatchObject({
      type: "task-event",
      messageId: aMessageId,
      senderId: A,
      recipientId: B,
      status: "accepted",
      detail: "change the API; /chat is plain text here",
    });
    expect(aReceipt).toMatchObject({ type: "delivery-receipt", status: "delivered", recipientIds: [B] });

    const bMessageId = randomUUID();
    const receivedByA = waitForEvent(a, (event) => event.type === "task-event" && event.messageId === bMessageId);
    const bReceipt = await b.sendTask("app", "adapt to the API", bMessageId);
    await expect(receivedByA).resolves.toMatchObject({ messageId: bMessageId, senderId: B, recipientId: A });
    expect(bReceipt.recipientIds).toEqual([A]);

    await b.close();
    expect((await a.list()).map((pal) => pal.id)).toEqual([A]);
  });

  it("renames on the authenticated socket while preserving its UUID", async () => {
    const broker = new PalBrokerServer({ address: address("rename") });
    brokers.push(broker);
    await broker.start();
    const client = new PalClient({ address: broker.address, registration: registration(A, "before") });
    clients.push(client);
    await client.start();

    const renamed = await client.rename("after");
    expect(renamed).toMatchObject({ id: A, alias: "after" });
    expect(await client.list()).toEqual([expect.objectContaining({ id: A, alias: "after" })]);
  });

  it("routes chat as opaque text and exposes its delivery receipt", async () => {
    const broker = new PalBrokerServer({ address: address("chat") });
    brokers.push(broker);
    await broker.start();
    const a = new PalClient({ address: broker.address, registration: registration(A, "app") });
    const b = new PalClient({ address: broker.address, registration: registration(B, "api") });
    clients.push(a, b);
    await Promise.all([a.start(), b.start()]);
    const messageId = randomUUID();
    const incoming = waitForEvent(b, (event) => event.type === "chat-event" && event.messageId === messageId);

    await expect(a.sendChat("api", "/co-work is text, not a command", messageId))
      .resolves.toMatchObject({ status: "delivered", recipientIds: [B] });
    await expect(incoming).resolves.toMatchObject({
      type: "chat-event",
      messageId,
      senderId: A,
      recipientId: B,
      message: "/co-work is text, not a command",
    });
  });

  it("proposes co-work and applies participant actions over the same event channel", async () => {
    const broker = new PalBrokerServer({ address: address("cowork") });
    brokers.push(broker);
    await broker.start();
    const a = new PalClient({ address: broker.address, registration: registration(A, "app") });
    const b = new PalClient({ address: broker.address, registration: registration(B, "api") });
    clients.push(a, b);
    await Promise.all([a.start(), b.start()]);
    const coWorkId = "40000000-0000-4000-8000-000000000001";
    const proposal = waitForEvent(b, (event) => event.type === "cowork-event" && event.coWorkId === coWorkId);

    await expect(a.startCoWork({
      coWorkId,
      goal: "change API and app together",
      participants: [{ palId: A, required: true }, { palId: B, required: true }],
    })).resolves.toMatchObject({ coWorkId, phase: "proposed", acceptedParticipantIds: [A] });
    await expect(proposal).resolves.toMatchObject({ type: "cowork-event", action: "PROPOSE", coWorkId });
    await expect(b.coWorkAction({ type: "cowork-accept", coWorkId, epoch: 1 }))
      .resolves.toMatchObject({ phase: "planning", acceptedParticipantIds: [A, B] });

    const plan = {
      version: 1 as const,
      coWorkId,
      epoch: 1,
      goal: "change API and app together",
      participants: [{ palId: A, required: true }, { palId: B, required: true }],
      tasks: [
        { id: "api", assigneeId: B, description: "change API", dependsOn: [] },
        { id: "app", assigneeId: A, description: "adapt app", dependsOn: ["api"] },
      ],
    };
    const planHash = canonicalPlanHash(plan);
    await a.coWorkAction({ type: "cowork-plan", plan });
    await a.coWorkAction({ type: "cowork-plan-accept", coWorkId, epoch: 1, planHash });
    await a.coWorkAction({ type: "cowork-ready", coWorkId, epoch: 1, planHash });
    await b.coWorkAction({ type: "cowork-plan-accept", coWorkId, epoch: 1, planHash });
    await b.coWorkAction({ type: "cowork-ready", coWorkId, epoch: 1, planHash });
    await a.coWorkAction({ type: "cowork-complete", coWorkId, epoch: 1, planHash, passed: true, detail: "app tests pass" });
    await b.coWorkAction({ type: "cowork-complete", coWorkId, epoch: 1, planHash, passed: true, detail: "api tests pass" });

    const ended = waitForEvent(b, (event) => event.type === "cowork-event" && event.action === "END");
    await expect(a.integrateCoWork({ coWorkId, epoch: 1, planHash, passed: true, evidence: "cross-project tests pass" }))
      .resolves.toMatchObject({ phase: "completed", integrationOwnerId: A, integration: { passed: true, evidence: "cross-project tests pass" } });
    await expect(ended).resolves.toMatchObject({ action: "END", actorId: A, coWorkId });
  });

  it("keeps an optional observer read-only while a sole required participant completes the lifecycle", async () => {
    const broker = new PalBrokerServer({ address: address("cowork-observer") });
    brokers.push(broker);
    await broker.start();
    const a = new PalClient({ address: broker.address, registration: registration(A, "app") });
    const b = new PalClient({ address: broker.address, registration: registration(B, "observer") });
    clients.push(a, b);
    await Promise.all([a.start(), b.start()]);
    const coWorkId = "40000000-0000-4000-8000-000000000003";
    const participants = [{ palId: A, required: true }, { palId: B, required: false }];

    await expect(a.startCoWork({ coWorkId, goal: "solo implementation with observer", participants }))
      .resolves.toMatchObject({ phase: "planning", integrationOwnerId: A, acceptedParticipantIds: [A] });
    const plan = {
      version: 1 as const, coWorkId, epoch: 1, goal: "solo implementation with observer", participants,
      tasks: [{ id: "app", assigneeId: A, description: "implement and verify", dependsOn: [] }],
    };
    const planHash = canonicalPlanHash(plan);
    await a.coWorkAction({ type: "cowork-plan", plan });
    await expect(b.coWorkAction({ type: "cowork-plan-accept", coWorkId, epoch: 1, planHash })).rejects.toThrow(/observer/i);
    await a.coWorkAction({ type: "cowork-plan-accept", coWorkId, epoch: 1, planHash });
    await expect(a.coWorkAction({ type: "cowork-ready", coWorkId, epoch: 1, planHash }))
      .resolves.toMatchObject({ phase: "running" });
    await expect(b.coWorkAction({
      type: "cowork-complete", coWorkId, epoch: 1, planHash, passed: false, detail: "force fail",
    })).rejects.toThrow(/observer/i);
    await expect(b.coWorkStatus(coWorkId)).resolves.toMatchObject({ phase: "running", completionAssertions: [] });
    await expect(a.coWorkAction({
      type: "cowork-complete", coWorkId, epoch: 1, planHash, passed: true, detail: "app tests pass",
    })).resolves.toMatchObject({ phase: "verifying" });
    await expect(a.integrateCoWork({ coWorkId, epoch: 1, planHash, passed: true, evidence: "integration passed" }))
      .resolves.toMatchObject({ phase: "completed" });
  });

  it("gets and cancels co-work with actor attribution over IPC", async () => {
    const broker = new PalBrokerServer({ address: address("cowork-cancel") });
    brokers.push(broker);
    await broker.start();
    const a = new PalClient({ address: broker.address, registration: registration(A, "app") });
    const b = new PalClient({ address: broker.address, registration: registration(B, "api") });
    clients.push(a, b);
    await Promise.all([a.start(), b.start()]);
    const coWorkId = "40000000-0000-4000-8000-000000000002";
    await a.startCoWork({ goal: "coordinate", coWorkId, participants: [{ palId: A, required: true }, { palId: B, required: true }] });
    await expect(b.coWorkStatus(coWorkId)).resolves.toMatchObject({ coWorkId, phase: "proposed" });
    const cancellation = waitForEvent(a, (event) => event.type === "cowork-event" && event.action === "CANCEL");
    await expect(b.cancelCoWork(coWorkId, "requirements changed")).resolves.toMatchObject({ phase: "cancelled" });
    await expect(cancellation).resolves.toMatchObject({ action: "CANCEL", actorId: B, coWorkId });
  });

  it("deduplicates repeated pushed events before notifying subscribers", async () => {
    const socketAddress = address("duplicate-events");
    const server = createServer((socket) => {
      let buffer = "";
      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        const request = JSON.parse(buffer.slice(0, newline)) as { requestId: string };
        socket.write(`${JSON.stringify({ version: 1, type: "ok", requestId: request.requestId, data: {
          version: 1, id: A, alias: "app", projectPath: "/work/app",
          connectedAt: new Date().toISOString(), lastSeenAt: new Date().toISOString(),
        } })}\n`);
        const event = {
          version: 1, type: "event", event: {
            version: 1, type: "delivery-receipt", messageId: "20000000-0000-4000-8000-000000000001",
            status: "delivered", recipientIds: [B],
          },
        };
        socket.write(`${JSON.stringify(event)}\n${JSON.stringify(event)}\n`);
      });
    });
    servers.push(server);
    await new Promise<void>((resolve, reject) => server.listen(socketAddress, resolve).once("error", reject));
    const client = new PalClient({ address: socketAddress, registration: registration(A, "app"), heartbeatIntervalMs: 60_000 });
    clients.push(client);
    const events: DeliveryReceipt[] = [];
    client.subscribe((event) => { if (event.type === "delivery-receipt") events.push(event); });
    await client.start();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(events).toHaveLength(1);
  });

  it("times requests out and cleans them up so a later request can succeed", async () => {
    const socketAddress = address("timeout") ;
    let requestCount = 0;
    const server = createServer((socket) => {
      let buffer = "";
      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        while (buffer.includes("\n")) {
          const newline = buffer.indexOf("\n");
          const request = JSON.parse(buffer.slice(0, newline)) as { requestId: string; type: string };
          buffer = buffer.slice(newline + 1);
          requestCount += 1;
          if (requestCount === 2) continue;
          socket.write(`${JSON.stringify({ version: 1, type: "ok", requestId: request.requestId, data: request.type === "list" ? [] : {
            version: 1, id: A, alias: "app", projectPath: "/work/app",
            connectedAt: new Date().toISOString(), lastSeenAt: new Date().toISOString(),
          } })}\n`);
        }
      });
    });
    servers.push(server);
    await new Promise<void>((resolve, reject) => server.listen(socketAddress, resolve).once("error", reject));
    const client = new PalClient({
      address: socketAddress,
      registration: registration(A, "app"),
      requestTimeoutMs: 20,
      heartbeatIntervalMs: 60_000,
    });
    clients.push(client);
    await client.start();
    await expect(client.list()).rejects.toThrow(/timed out/i);
    await expect(client.list()).resolves.toEqual([]);
  });

  it("rejects pending requests promptly when closed", async () => {
    const socketAddress = address("pending-close");
    const server = createServer((socket) => socket.on("data", () => undefined));
    servers.push(server);
    await new Promise<void>((resolve, reject) => server.listen(socketAddress, resolve).once("error", reject));
    const client = new PalClient({
      address: socketAddress,
      registration: registration(A, "app"),
      requestTimeoutMs: 10_000,
      heartbeatIntervalMs: 60_000,
    });
    clients.push(client);
    const starting = client.start();
    await new Promise((resolve) => setTimeout(resolve, 10));
    await client.close();
    await expect(starting).rejects.toThrow(/closed/i);
  });

  it("settles an in-flight connection attempt when closed", async () => {
    const client = new PalClient({
      address: address("connecting-close"),
      authToken: AUTH_TOKEN,
      registration: registration(A, "app"),
      connect: () => new Socket(),
    });
    clients.push(client);
    const starting = client.start().then(
      () => "started",
      (error: unknown) => error instanceof Error ? error.message : String(error),
    );
    await client.close();
    await expect(Promise.race([
      starting,
      new Promise<string>((resolve) => setTimeout(() => resolve("still pending"), 30)),
    ])).resolves.toMatch(/closed/i);
  });

  it("closes a socket whose registration is rejected", async () => {
    const broker = new PalBrokerServer({ address: address("register-rejected") });
    brokers.push(broker);
    await broker.start();
    const accepted = new PalClient({ address: broker.address, registration: registration(A, "app") });
    const rejected = new PalClient({ address: broker.address, registration: registration(A, "duplicate") });
    clients.push(accepted, rejected);
    await accepted.start();
    await expect(rejected.start()).rejects.toThrow(/already connected/i);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(broker.connectionCount).toBe(1);
  });

  it("reconnects with bounded delays and registers again after broker restart", async () => {
    const socketAddress = address("reconnect");
    const first = new PalBrokerServer({ address: socketAddress });
    brokers.push(first);
    await first.start();
    const client = new PalClient({
      address: socketAddress,
      registration: registration(A, "app"),
      reconnectMinDelayMs: 5,
      reconnectMaxDelayMs: 10,
    });
    clients.push(client);
    await client.start();
    await first.close();
    const second = new PalBrokerServer({ address: socketAddress });
    brokers.push(second);
    await second.start();

    const deadline = Date.now() + 500;
    let listed: PalPresence[] | undefined;
    while (Date.now() < deadline) {
      try {
        listed = await client.list();
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    expect(listed).toEqual([expect.objectContaining({ id: A, alias: "app" })]);
  });

  it("allows only one unanswered heartbeat request at a time", async () => {
    const socketAddress = address("heartbeat-bound");
    let heartbeats = 0;
    const server = createServer((socket) => {
      let buffer = "";
      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        while (buffer.includes("\n")) {
          const newline = buffer.indexOf("\n");
          const request = JSON.parse(buffer.slice(0, newline)) as { requestId: string; type: string };
          buffer = buffer.slice(newline + 1);
          if (request.type === "heartbeat") {
            heartbeats += 1;
            continue;
          }
          socket.write(`${JSON.stringify({ version: 1, type: "ok", requestId: request.requestId, data: request.type === "disconnect" ? null : {
            version: 1, id: A, alias: "app", projectPath: "/work/app",
            connectedAt: new Date().toISOString(), lastSeenAt: new Date().toISOString(),
          } })}\n`);
        }
      });
    });
    servers.push(server);
    await new Promise<void>((resolve, reject) => server.listen(socketAddress, resolve).once("error", reject));
    const client = new PalClient({
      address: socketAddress,
      registration: registration(A, "app"),
      heartbeatIntervalMs: 5,
      requestTimeoutMs: 100,
    });
    clients.push(client);
    await client.start();
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(heartbeats).toBe(1);
  });
});
