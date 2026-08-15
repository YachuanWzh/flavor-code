import { describe, expect, it } from "vitest";

import {
  BrokerRequestSchema,
  BrokerResponseSchema,
  CoWorkPlanSchema,
  CoWorkSnapshotSchema,
  ControlFrameSchema,
  DeliveryReceiptSchema,
  encodeControlFrame,
  MAX_ACTIVE_PALS,
  MAX_CONTROL_FRAME_BYTES,
  MAX_PROJECT_PATH_BYTES,
  MIN_UUID_PREFIX_LENGTH,
  PalPresenceSchema,
  PalTaskEventSchema,
  PalTaskMessageSchema,
} from "../../src/pals/protocol.js";

const UUID_A = "10000000-0000-4000-8000-000000000001";
const UUID_B = "10000000-0000-4000-8000-000000000002";

describe("pals protocol v1", () => {
  it("strictly validates presence and public text bounds", () => {
    const presence = {
      version: 1,
      id: UUID_A,
      alias: "api",
      projectPath: "/work/api",
      connectedAt: "2026-08-14T01:00:00.000Z",
      lastSeenAt: "2026-08-14T01:00:01.000Z",
    };
    expect(PalPresenceSchema.parse(presence)).toEqual(presence);
    expect(PalPresenceSchema.safeParse({ ...presence, alias: "x".repeat(65) }).success).toBe(false);
    expect(PalPresenceSchema.safeParse({ ...presence, surprise: true }).success).toBe(false);

    const task = {
      version: 1,
      type: "task",
      messageId: "20000000-0000-4000-8000-000000000001",
      target: "api",
      goal: "update the API",
    };
    expect(PalTaskMessageSchema.parse(task)).toEqual(task);
    expect(PalTaskMessageSchema.safeParse({ ...task, goal: "g".repeat(32 * 1024 + 1) }).success).toBe(false);
  });

  it("validates task events and delivery receipts as strict discriminated records", () => {
    expect(PalTaskEventSchema.parse({
      version: 1,
      type: "task-event",
      messageId: "20000000-0000-4000-8000-000000000001",
      taskId: "30000000-0000-4000-8000-000000000001",
      senderId: UUID_A,
      recipientId: UUID_B,
      status: "started",
      detail: "working",
    })).toMatchObject({ status: "started" });

    expect(DeliveryReceiptSchema.parse({
      version: 1,
      type: "delivery-receipt",
      messageId: "20000000-0000-4000-8000-000000000001",
      status: "delivered",
      recipientIds: [UUID_B],
    })).toMatchObject({ status: "delivered" });
    expect(DeliveryReceiptSchema.safeParse({
      version: 1,
      type: "delivery-receipt",
      messageId: "20000000-0000-4000-8000-000000000001",
      status: "invented",
      recipientIds: [],
    }).success).toBe(false);
  });

  it("bounds co-work participants and plan tasks without embedding platform details", () => {
    const participants = Array.from({ length: 16 }, (_, index) => ({
      palId: `10000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      required: index < 2,
    }));
    const plan = {
      version: 1,
      coWorkId: "40000000-0000-4000-8000-000000000001",
      epoch: 1,
      goal: "coordinate changes",
      participants,
      tasks: Array.from({ length: 128 }, (_, index) => ({
        id: `task-${index}`,
        assigneeId: participants[index % participants.length]!.palId,
        description: `step ${index}`,
        dependsOn: index === 0 ? [] : [`task-${index - 1}`],
      })),
    };
    expect(CoWorkPlanSchema.parse({ ...plan, tasks: plan.tasks.slice(0, 32) }).tasks).toHaveLength(32);
    expect(CoWorkPlanSchema.safeParse({ ...plan, participants: [...participants, participants[0]] }).success).toBe(false);
    expect(CoWorkPlanSchema.safeParse({ ...plan, tasks: [...plan.tasks, plan.tasks[0]] }).success).toBe(false);

    const cyclic = {
      ...plan,
      tasks: [
        { id: "contract", assigneeId: UUID_A, description: "publish contract", dependsOn: ["client"] },
        { id: "server", assigneeId: UUID_B, description: "update server", dependsOn: ["contract"] },
        { id: "client", assigneeId: UUID_A, description: "update client", dependsOn: ["server"] },
      ],
    };
    expect(CoWorkPlanSchema.safeParse(cyclic).success).toBe(false);

    expect(CoWorkSnapshotSchema.parse({
      version: 1,
      coWorkId: plan.coWorkId,
      epoch: 1,
      phase: "planning",
      goal: plan.goal,
      participants,
      integrationOwnerId: UUID_A,
      acceptedParticipantIds: [UUID_A],
      planHash: null,
      plan: null,
      planAcceptedParticipantIds: [],
      readyParticipantIds: [],
      completedParticipantIds: [],
      completionAssertions: [],
      integration: null,
    })).toMatchObject({ phase: "planning" });

    expect(CoWorkSnapshotSchema.safeParse({
      version: 1,
      coWorkId: plan.coWorkId,
      epoch: 1,
      phase: "running",
      goal: plan.goal,
      participants,
      integrationOwnerId: UUID_A,
      acceptedParticipantIds: participants.map(({ palId }) => palId),
      planHash: "a".repeat(64),
      plan,
      planAcceptedParticipantIds: participants.map(({ palId }) => palId),
      readyParticipantIds: participants.map(({ palId }) => palId),
      completedParticipantIds: [],
      completionAssertions: participants.slice(0, 7).map(({ palId }) => ({
        participantId: palId,
        passed: true,
        detail: "x".repeat(4 * 1024),
      })),
      integration: null,
    }).success).toBe(false);
  });

  it("validates broker request/response unions and rejects oversized control frames", () => {
    const request = BrokerRequestSchema.parse({
      version: 1,
      type: "chat",
      requestId: "50000000-0000-4000-8000-000000000001",
      messageId: "50000000-0000-4000-8000-000000000002",
      target: "api",
      message: "hello",
    });
    expect(request.type).toBe("chat");

    expect(BrokerResponseSchema.parse({
      version: 1,
      type: "ok",
      requestId: request.requestId,
      data: { accepted: true },
    })).toMatchObject({ type: "ok" });
    expect(BrokerRequestSchema.safeParse({ ...request, extra: true }).success).toBe(false);

    expect(ControlFrameSchema.parse(JSON.stringify(request))).toBe(JSON.stringify(request));
    expect(ControlFrameSchema.safeParse("x".repeat(MAX_CONTROL_FRAME_BYTES + 1)).success).toBe(false);
    expect(() => encodeControlFrame({ payload: "x".repeat(MAX_CONTROL_FRAME_BYTES) })).toThrow(/frame.*large/i);
  });

  it("rejects terminal controls in aliases and targets and exports one UUID prefix minimum", () => {
    expect(MIN_UUID_PREFIX_LENGTH).toBe(8);
    const presence = {
      version: 1, id: UUID_A, alias: "api\u001b[31m", projectPath: "/work/api",
      connectedAt: "2026-08-14T01:00:00.000Z", lastSeenAt: "2026-08-14T01:00:01.000Z",
    };
    expect(PalPresenceSchema.safeParse(presence).success).toBe(false);
    for (const target of ["api\nforged", "api\u0085line", "api\ud800"]) {
      expect(BrokerRequestSchema.safeParse({
        version: 1, type: "chat", requestId: crypto.randomUUID(), messageId: crypto.randomUUID(), target, message: "hello",
      }).success, JSON.stringify(target)).toBe(false);
    }
  });

  it("keeps worst-case valid list, plan, and snapshot envelopes below the control-frame limit", () => {
    const pals = Array.from({ length: MAX_ACTIVE_PALS }, (_, index) => ({
      version: 1 as const,
      id: `10000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      alias: `pal-${index}`,
      projectPath: "p".repeat(MAX_PROJECT_PATH_BYTES),
      connectedAt: "2026-08-14T01:00:00.000Z",
      lastSeenAt: "2026-08-14T01:00:01.000Z",
    }));
    expect(PalPresenceSchema.array().max(MAX_ACTIVE_PALS).safeParse(pals).success).toBe(true);
    expect(Buffer.byteLength(encodeControlFrame({ version: 1, type: "ok", requestId: crypto.randomUUID(), data: pals }), "utf8"))
      .toBeLessThanOrEqual(MAX_CONTROL_FRAME_BYTES + 1);

    const participants = pals.map(({ id }) => ({ palId: id, required: true }));
    const plan = CoWorkPlanSchema.parse({
      version: 1, coWorkId: crypto.randomUUID(), epoch: 1, goal: "g".repeat(4_000), participants,
      tasks: Array.from({ length: 32 }, (_, index) => ({
        id: `task-${index}`, assigneeId: participants[index % participants.length]!.palId,
        description: "d".repeat(300), dependsOn: index === 0 ? [] : [`task-${index - 1}`],
      })),
    });
    const snapshot = CoWorkSnapshotSchema.parse({
      version: 1, coWorkId: plan.coWorkId, epoch: 1, phase: "verifying", goal: plan.goal,
      participants, integrationOwnerId: participants[0]!.palId,
      acceptedParticipantIds: participants.map(({ palId }) => palId), planHash: "a".repeat(64), plan,
      planAcceptedParticipantIds: participants.map(({ palId }) => palId), readyParticipantIds: participants.map(({ palId }) => palId),
      completedParticipantIds: participants.map(({ palId }) => palId),
      completionAssertions: participants.map(({ palId }) => ({ participantId: palId, passed: true, detail: "e".repeat(500) })),
      integration: null,
    });
    expect(Buffer.byteLength(encodeControlFrame({ version: 1, type: "event", event: {
      version: 1, type: "cowork-event", action: "START", actorId: UUID_A, coWorkId: plan.coWorkId,
      epoch: 1, planHash: "a".repeat(64), snapshot,
    } }), "utf8")).toBeLessThanOrEqual(MAX_CONTROL_FRAME_BYTES + 1);
  });

  it("strictly validates co-work status/cancel requests and attributed events", () => {
    const coWorkId = "40000000-0000-4000-8000-000000000001";
    expect(BrokerRequestSchema.parse({
      version: 1, type: "cowork-get", requestId: "50000000-0000-4000-8000-000000000001", coWorkId,
    })).toMatchObject({ type: "cowork-get", coWorkId });
    expect(BrokerRequestSchema.parse({
      version: 1, type: "cowork-cancel", requestId: "50000000-0000-4000-8000-000000000002", coWorkId,
      reason: "requirements changed",
    })).toMatchObject({ type: "cowork-cancel", reason: "requirements changed" });
    expect(BrokerRequestSchema.safeParse({
      version: 1, type: "cowork-cancel", requestId: "50000000-0000-4000-8000-000000000002", coWorkId, reason: "",
    }).success).toBe(false);

    const snapshot = {
      version: 1, coWorkId, epoch: 1, phase: "cancelled", goal: "coordinate",
      participants: [{ palId: UUID_A, required: true }], integrationOwnerId: UUID_A, acceptedParticipantIds: [UUID_A],
      planHash: null, plan: null, planAcceptedParticipantIds: [], readyParticipantIds: [],
      completedParticipantIds: [], completionAssertions: [], integration: null,
    };
    expect(BrokerResponseSchema.parse({ version: 1, type: "event", event: {
      version: 1, type: "cowork-event", action: "CANCEL", actorId: UUID_A,
      coWorkId, epoch: 1, planHash: null, snapshot,
    } })).toMatchObject({ event: { action: "CANCEL", actorId: UUID_A } });
  });

  it("rejects duplicate and self-only co-work proposal rosters", () => {
    const base = {
      version: 1 as const,
      type: "cowork-propose" as const,
      requestId: "50000000-0000-4000-8000-000000000010",
      coWorkId: "40000000-0000-4000-8000-000000000010",
      goal: "coordinate",
    };
    expect(BrokerRequestSchema.safeParse({ ...base, participants: [{ palId: UUID_A, required: true }] }).success).toBe(false);
    expect(BrokerRequestSchema.safeParse({
      ...base,
      participants: [{ palId: UUID_A, required: true }, { palId: UUID_A, required: true }],
    }).success).toBe(false);
  });

  it("requires nonempty bounded integration evidence and accepts FAIL events", () => {
    const base = {
      version: 1 as const,
      type: "cowork-integration" as const,
      requestId: "50000000-0000-4000-8000-000000000020",
      coWorkId: "40000000-0000-4000-8000-000000000020",
      epoch: 1,
      planHash: "a".repeat(64),
      passed: true,
    };
    expect(BrokerRequestSchema.safeParse(base).success).toBe(false);
    expect(BrokerRequestSchema.safeParse({ ...base, evidence: "cross-project tests passed" }).success).toBe(true);

    const snapshot = {
      version: 1 as const, coWorkId: base.coWorkId, epoch: 1, phase: "failed" as const, goal: "coordinate",
      participants: [{ palId: UUID_A, required: true }, { palId: UUID_B, required: true }],
      integrationOwnerId: UUID_A, acceptedParticipantIds: [UUID_A, UUID_B],
      planHash: base.planHash, plan: null, planAcceptedParticipantIds: [UUID_A, UUID_B], readyParticipantIds: [UUID_A, UUID_B],
      completedParticipantIds: [], completionAssertions: [{ participantId: UUID_B, passed: false, detail: "tests failed" }],
      integration: null,
    };
    expect(BrokerResponseSchema.safeParse({ version: 1, type: "event", event: {
      version: 1, type: "cowork-event", action: "FAIL", actorId: UUID_B,
      coWorkId: base.coWorkId, epoch: 1, planHash: base.planHash, snapshot,
    } }).success).toBe(true);
  });
});
