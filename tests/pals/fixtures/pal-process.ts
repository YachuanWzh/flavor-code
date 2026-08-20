import { createInterface } from "node:readline";

import type { PermissionMode } from "../../../src/config/schema.js";
import { HookBus } from "../../../src/hooks/bus.js";
import { PalBrokerServer } from "../../../src/pals/broker.js";
import { ensurePalBrokerRunning } from "../../../src/pals/broker-cli.js";
import { PalClient } from "../../../src/pals/client.js";
import type { BrokerEvent, CoWorkParticipant, CoWorkPlan } from "../../../src/pals/protocol.js";
import { QuestionBridge } from "../../../src/tools/ask-user-question.js";
import { FlavorSession, type SessionServices } from "../../../src/ui/session.js";

function emit(event: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

async function runBrokerEnsureFixture(address: string | undefined, authHome: string | undefined): Promise<void> {
  if (address === undefined || authHome === undefined) throw new Error("Usage: pal-process --ensure-broker <address> <auth-home>");
  let ownedBroker: PalBrokerServer | undefined;
  await ensurePalBrokerRunning({
    address,
    timeoutMs: 5_000,
    retryDelayMs: 10,
    startBroker: async () => {
      const candidate = new PalBrokerServer({ address, authHome });
      try {
        await candidate.start();
        ownedBroker = candidate;
      } catch {
        await candidate.close().catch(() => undefined);
        // A competing process may win listen(). ensure performs the bounded connectivity check.
      }
    },
  });
  emit({ type: "broker-ready", owner: ownedBroker !== undefined });
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  input.on("line", (line) => {
    const command = JSON.parse(line) as { type: string };
    if (command.type !== "close") return;
    void (async () => {
      await ownedBroker?.close();
      emit({ type: "closed" });
      input.close();
      process.stdin.destroy();
    })();
  });
}

async function runPeerFixture(args: string[]): Promise<void> {
  const [address, id, alias, projectPath, authHome] = args;
  if (address === undefined || id === undefined || alias === undefined || projectPath === undefined || authHome === undefined) {
    throw new Error("Usage: pal-process <address> <uuid> <alias> <project-path> <auth-home>");
  }

  const peerId = id;
  let permissionMode: PermissionMode = "default";
  let mutationExecutions = 0;
  let workStarts = 0;
  let workCompletions = 0;
  const workReleases = new Map<string, () => void>();
  const hooks = new HookBus();
  const services: SessionServices = {
    hooks,
    workspace: projectPath,
    mainModel: () => "fake:acceptance",
    subagentModel: () => "fake:acceptance",
    permissionMode: () => permissionMode,
    run: async function* (prompt, signal) {
      const messageId = /Message UUID: ("[^"]+")/.exec(prompt)?.[1];
      const coWorkIdJson = /Co-work UUID: ("[^"]+")/.exec(prompt)?.[1];
      const coWorkId = coWorkIdJson === undefined ? undefined : JSON.parse(coWorkIdJson) as string;
      const phase = prompt.includes("co-work START event") ? "work"
        : prompt.includes("co-work PROPOSE event") || prompt.includes("co-work PLAN event") ? "planning" : "task";
      emit({
        type: "model-run",
        messageId: messageId === undefined ? undefined : JSON.parse(messageId),
        coWorkId,
        phase,
        permissionMode,
        mutationExecutions,
        prompt,
      });
      if (phase === "work" && coWorkId !== undefined) {
        workStarts += 1;
        emit({ type: "work-started", coWorkId, timestamp: Date.now(), permissionMode });
        await new Promise<void>((resolveWork) => {
          const finish = () => {
            signal.removeEventListener("abort", finish);
            workReleases.delete(coWorkId);
            resolveWork();
          };
          workReleases.set(coWorkId, finish);
          signal.addEventListener("abort", finish, { once: true });
        });
        if (!signal.aborted) {
          workCompletions += 1;
          emit({ type: "work-completed", coWorkId, timestamp: Date.now() });
        }
      }
      yield { type: "done", usage: { inputTokens: 0, outputTokens: 0 } };
    },
    runSkill: async function* () {},
    runLoop: async function* () {},
    runGoal: async function* () {},
    mcp: async () => "",
    ide: async () => "",
    setModel: () => undefined,
    setPermissionMode: (mode) => {
      permissionMode = mode;
      emit({ type: "permission-changed", permissionMode: mode });
    },
    compact: async () => false,
    initialize: async () => ({ path: projectPath, created: false }),
    config: () => ({}),
    skills: async () => [],
    plugins: () => [],
    hooksStatus: () => [],
    tasks: () => [],
    audit: () => "",
    evolve: () => "",
    usage: () => "",
    cancelActiveTask: () => undefined,
    clearContext: async () => undefined,
    memory: async () => "",
    remember: async () => "",
    forget: async () => "",
    forgetCold: async () => "",
    finishTask: async () => "",
    pluginCommands: () => [],
    runPluginCommand: async () => undefined,
    output: () => undefined,
    questions: new QuestionBridge(),
    login: async () => "",
    logout: async () => "",
  };

  const session = new FlavorSession(services);
  const client = new PalClient({
    address,
    authHome,
    registration: { id, alias, projectPath },
    requestTimeoutMs: 2_000,
    heartbeatIntervalMs: 500,
    reconnectMinDelayMs: 10,
    reconnectMaxDelayMs: 100,
  });

  let eventTail = Promise.resolve();

  async function receive(event: BrokerEvent): Promise<void> {
    if (event.type === "cowork-event") {
      emit({
        type: "cowork-wire",
        action: event.action,
        actorId: event.actorId,
        coWorkId: event.coWorkId,
        epoch: event.epoch,
        planHash: event.planHash,
        phase: event.snapshot.phase,
      });
      if (event.action === "PROPOSE"
        && event.snapshot.participants.some(({ palId, required }) => palId === peerId && required)
        && !event.snapshot.acceptedParticipantIds.includes(peerId)) {
        await client.coWorkAction({ type: "cowork-accept", coWorkId: event.coWorkId, epoch: event.epoch });
      }
      const senderAlias = (await client.list()).find((pal) => pal.id === event.actorId)?.alias ?? event.actorId.slice(0, 8);
      const deliveryBase = {
        senderId: event.actorId,
        senderAlias,
        localId: peerId,
        coWorkId: event.coWorkId,
        epoch: event.epoch,
        snapshot: event.snapshot,
      };
      await session.receivePalCoWorkEvent(event.action === "START"
        ? { ...deliveryBase, action: "START", planHash: event.planHash! }
        : { ...deliveryBase, action: event.action, planHash: event.planHash });
      return;
    }
    if (event.type !== "task-event" || event.status !== "accepted" || event.detail === undefined) return;
    const senderAlias = (await client.list()).find((pal) => pal.id === event.senderId)?.alias ?? event.senderId.slice(0, 8);
    emit({
      type: "task-received",
      senderId: event.senderId,
      senderAlias,
      messageId: event.messageId,
      taskId: event.taskId,
      goal: event.detail,
    });
    session.receivePalTask({
      senderId: event.senderId,
      senderAlias,
      messageId: event.messageId,
      taskId: event.taskId,
      goal: event.detail,
    });
    await session.whenIdle();
    emit({ type: "work-started", messageId: event.messageId });
  }

  client.subscribe((event) => {
    eventTail = eventTail.catch(() => {}).then(() => receive(event));
  });

  await client.start();
  emit({ type: "ready", id, alias });

  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  input.on("line", (line) => {
    void (async () => {
      const command = JSON.parse(line) as {
        type: string;
        commandId: string;
        target?: string;
        message?: string;
        messageId?: string;
        coWorkId?: string;
        goal?: string;
        participants?: CoWorkParticipant[];
        plan?: CoWorkPlan;
        epoch?: number;
        planHash?: string;
        passed?: boolean;
        detail?: string;
        evidence?: string;
        reason?: string;
      };
      if (command.type === "list") {
        emit({ type: "result", commandId: command.commandId, pals: await client.list() });
        return;
      }
      if (command.type === "send") {
        if (command.target === undefined || command.message === undefined || command.messageId === undefined) throw new Error("send requires target, message, and messageId");
        emit({ type: "result", commandId: command.commandId, receipt: await client.sendTask(command.target, command.message, command.messageId) });
        return;
      }
      if (command.type === "cowork-propose") {
        if (command.coWorkId === undefined || command.goal === undefined || command.participants === undefined) throw new Error("cowork-propose requires inputs");
        emit({ type: "result", commandId: command.commandId, snapshot: await client.startCoWork({ coWorkId: command.coWorkId, goal: command.goal, participants: command.participants }) });
        return;
      }
      if (command.type === "cowork-plan") {
        if (command.plan === undefined) throw new Error("cowork-plan requires plan");
        emit({ type: "result", commandId: command.commandId, snapshot: await client.coWorkAction({ type: "cowork-plan", plan: command.plan }) });
        return;
      }
      if (command.type === "cowork-ready") {
        if (command.coWorkId === undefined || command.epoch === undefined || command.planHash === undefined) throw new Error("cowork-ready requires token");
        const token = { coWorkId: command.coWorkId, epoch: command.epoch, planHash: command.planHash };
        await client.coWorkAction({ type: "cowork-plan-accept", ...token });
        emit({ type: "result", commandId: command.commandId, snapshot: await client.coWorkAction({ type: "cowork-ready", ...token }) });
        return;
      }
      if (command.type === "cowork-complete") {
        if (command.coWorkId === undefined || command.epoch === undefined || command.planHash === undefined || command.passed === undefined) throw new Error("cowork-complete requires assertion");
        emit({ type: "result", commandId: command.commandId, snapshot: await client.coWorkAction({
          type: "cowork-complete", coWorkId: command.coWorkId, epoch: command.epoch, planHash: command.planHash,
          passed: command.passed, ...(command.detail === undefined ? {} : { detail: command.detail }),
        }) });
        return;
      }
      if (command.type === "cowork-integrate") {
        if (command.coWorkId === undefined || command.epoch === undefined || command.planHash === undefined || command.passed === undefined || command.evidence === undefined) throw new Error("cowork-integrate requires result");
        emit({ type: "result", commandId: command.commandId, snapshot: await client.integrateCoWork({
          coWorkId: command.coWorkId, epoch: command.epoch, planHash: command.planHash, passed: command.passed, evidence: command.evidence,
        }) });
        return;
      }
      if (command.type === "cowork-cancel") {
        if (command.coWorkId === undefined || command.reason === undefined) throw new Error("cowork-cancel requires reason");
        emit({ type: "result", commandId: command.commandId, snapshot: await client.cancelCoWork(command.coWorkId, command.reason) });
        return;
      }
      if (command.type === "release-work") {
        if (command.coWorkId === undefined) throw new Error("release-work requires coWorkId");
        workReleases.get(command.coWorkId)?.();
        emit({ type: "result", commandId: command.commandId });
        return;
      }
      if (command.type === "idle") {
        await eventTail;
        await session.whenIdle();
        emit({ type: "result", commandId: command.commandId });
        return;
      }
      if (command.type === "barrier") {
        await eventTail;
        emit({ type: "result", commandId: command.commandId });
        return;
      }
      if (command.type === "stats") {
        emit({ type: "result", commandId: command.commandId, permissionMode, mutationExecutions, workStarts, workCompletions });
        return;
      }
      if (command.type === "close") {
        for (const release of workReleases.values()) release();
        await eventTail;
        await session.close();
        await client.close();
        emit({ type: "result", commandId: command.commandId });
        input.close();
        process.stdin.destroy();
        return;
      }
      throw new Error(`Unknown fixture command '${command.type}'`);
    })().catch((error: unknown) => {
      emit({ type: "result", commandId: JSON.parse(line).commandId, error: error instanceof Error ? error.message : String(error) });
    });
  });
}

const args = process.argv.slice(2);
if (args[0] === "--ensure-broker") await runBrokerEnsureFixture(args[1], args[2]);
else await runPeerFixture(args);
