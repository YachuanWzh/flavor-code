import { describe, expect, it, vi } from "vitest";

import { CollaborationShareGuard, createPalsTools, type PalClientLike } from "../../src/pals/tools.js";
import type { BrokerEvent, CoWorkPlan, CoWorkSnapshot, PalPresence } from "../../src/pals/protocol.js";

const A = "10000000-0000-4000-8000-000000000001";
const B = "10000000-0000-4000-8000-000000000002";
const COWORK = "40000000-0000-4000-8000-000000000001";
const HASH = "a".repeat(64);

function presence(id: string, alias: string): PalPresence {
  return { version: 1, id, alias, projectPath: `/work/${alias}`, connectedAt: new Date(0).toISOString(), lastSeenAt: new Date(0).toISOString() };
}

function snapshot(overrides: Partial<CoWorkSnapshot> = {}): CoWorkSnapshot {
  return {
    version: 1, coWorkId: COWORK, epoch: 2, phase: "prepared", goal: "ship together",
    participants: [{ palId: A, required: true }, { palId: B, required: true }],
    integrationOwnerId: A,
    acceptedParticipantIds: [A, B], planHash: HASH, plan: null,
    planAcceptedParticipantIds: [A, B], readyParticipantIds: [], completedParticipantIds: [], completionAssertions: [], integration: null,
    ...overrides,
  };
}

function fakeClient(): PalClientLike & { [key: string]: unknown } {
  return {
    start: vi.fn(async () => presence(A, "app")),
    list: vi.fn(async () => [presence(A, "app"), presence(B, "api")]),
    rename: vi.fn(),
    sendTask: vi.fn(async () => ({ version: 1 as const, type: "delivery-receipt" as const, messageId: crypto.randomUUID(), status: "delivered" as const, recipientIds: [B] })),
    sendChat: vi.fn(async () => ({ version: 1 as const, type: "delivery-receipt" as const, messageId: crypto.randomUUID(), status: "delivered" as const, recipientIds: [B] })),
    startCoWork: vi.fn(async () => snapshot({ phase: "proposed", planHash: null })),
    coWorkAction: vi.fn(async () => snapshot()),
    coWorkStatus: vi.fn(async () => snapshot()),
    integrateCoWork: vi.fn(async () => snapshot({ phase: "completed", integration: { passed: true, evidence: "tests passed" } })),
    cancelCoWork: vi.fn(async () => snapshot({ phase: "cancelled" })),
    subscribe: vi.fn((_listener: (event: BrokerEvent) => void) => () => undefined),
    close: vi.fn(async () => undefined),
  };
}

function tool(client: PalClientLike, name: string) {
  const found = createPalsTools(client, { selfId: A }).find((candidate) => candidate.name === name);
  if (found === undefined) throw new Error(`missing tool ${name}`);
  return found;
}

describe("model-facing pals tools", () => {
  it("redacts every outbound content field and enforces one cumulative UTF-8 budget", async () => {
    const client = fakeClient();
    const secret = "sk-live-secret";
    const guard = new CollaborationShareGuard({
      maxBytes: 90,
      redact: (value) => value.replaceAll(secret, "[REDACTED]"),
    });
    const guarded = createPalsTools(client, { selfId: A, shareGuard: guard });
    const byName = (name: string) => guarded.find((candidate) => candidate.name === name)!;

    await byName("PalSend").execute({ target: "api", message: `token=${secret}` }, new AbortController().signal);
    expect(client.sendChat).toHaveBeenLastCalledWith(B, "token=[REDACTED]");

    const plan: CoWorkPlan = {
      version: 1, coWorkId: COWORK, epoch: 2, goal: `goal ${secret}`,
      participants: [{ palId: A, required: true }, { palId: B, required: true }],
      tasks: [{ id: "api", assigneeId: B, description: `task ${secret}`, dependsOn: [] }],
    };
    await byName("CoWorkPlan").execute({ plan }, new AbortController().signal);
    expect(client.coWorkAction).toHaveBeenLastCalledWith(expect.objectContaining({
      type: "cowork-plan",
      plan: expect.objectContaining({
        goal: "goal [REDACTED]",
        tasks: [expect.objectContaining({ description: "task [REDACTED]" })],
      }),
    }));

    await expect(byName("PalSend").execute({ target: "api", message: "x".repeat(60) }, new AbortController().signal))
      .rejects.toThrow(/sharing budget/i);
    expect(client.sendChat).toHaveBeenCalledTimes(1);
  });

  it("exposes only bounded metadata, never raw shared content, to approval requests", () => {
    const send = tool(fakeClient(), "PalSend");
    const metadata = send.permissionInput?.({ target: "api", message: "top-secret-payload" } as never);
    expect(JSON.stringify(metadata)).not.toContain("top-secret-payload");
    expect(metadata).toMatchObject({ target: "api", sharedBytes: 18 });
  });

  it("marks every content-bearing collaboration tool as once-only approval", () => {
    const tools = createPalsTools(fakeClient(), { selfId: A });
    for (const name of ["PalSend", "CoWorkPlan", "CoWorkProgress", "CoWorkComplete", "CoWorkIntegrate"]) {
      const definition = tools.find((candidate) => candidate.name === name)!;
      expect(definition.permissions?.({})).toEqual({ allowAlways: false });
    }
    for (const name of ["PalsList", "CoWorkState", "CoWorkReady"]) {
      expect(tools.find((candidate) => candidate.name === name)?.permissions).toBeUndefined();
    }
  });
  it("registers the bounded main-agent-only tool surface", () => {
    const tools = createPalsTools(fakeClient(), { selfId: A });
    expect(tools.map(({ name }) => name)).toEqual([
      "PalsList", "PalSend", "CoWorkState", "CoWorkPlan", "CoWorkReady", "CoWorkProgress", "CoWorkComplete", "CoWorkIntegrate",
    ]);
    expect(tools.every(({ agents, paths }) => agents?.join() === "main" && paths({} as never).length === 0)).toBe(true);
    expect(tools.every(({ inputSchema }) => inputSchema.safeParse({ unexpected: true }).success === false)).toBe(true);
  });

  it("lists only bounded presence fields without project paths", async () => {
    const result = await tool(fakeClient(), "PalsList").execute({}, new AbortController().signal);
    expect(result).toEqual([
      { id: A, alias: "app", connectedAt: new Date(0).toISOString(), lastSeenAt: new Date(0).toISOString() },
      { id: B, alias: "api", connectedAt: new Date(0).toISOString(), lastSeenAt: new Date(0).toISOString() },
    ]);
  });

  it("PalSend refuses inactive non-members and permits an accepted co-work member", async () => {
    const client = fakeClient();
    (client.list as ReturnType<typeof vi.fn>).mockResolvedValue([presence(A, "app")]);
    await expect(tool(client, "PalSend").execute({ target: B, message: "fact" }, new AbortController().signal)).rejects.toThrow(/active|member/i);
    (client.coWorkStatus as ReturnType<typeof vi.fn>).mockResolvedValue(snapshot());
    await tool(client, "PalSend").execute({ target: B, message: "fact", coWorkId: COWORK }, new AbortController().signal);
    expect(client.sendChat).toHaveBeenCalledWith(B, "fact");
  });

  it("CoWorkReady verifies the exact current epoch and plan hash", async () => {
    const client = fakeClient();
    await expect(tool(client, "CoWorkReady").execute({ coWorkId: COWORK, epoch: 1, planHash: HASH }, new AbortController().signal)).rejects.toThrow(/current/i);
    await tool(client, "CoWorkReady").execute({ coWorkId: COWORK, epoch: 2, planHash: HASH }, new AbortController().signal);
    expect(client.coWorkAction).toHaveBeenCalledWith({ type: "cowork-ready", coWorkId: COWORK, epoch: 2, planHash: HASH });
  });

  it("CoWorkReady accepts the exact canonical plan before declaring local readiness", async () => {
    const client = fakeClient();
    (client.coWorkStatus as ReturnType<typeof vi.fn>).mockResolvedValue(snapshot({
      phase: "planning", planAcceptedParticipantIds: [B],
    }));
    (client.coWorkAction as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(snapshot({ phase: "prepared", planAcceptedParticipantIds: [A, B] }))
      .mockResolvedValueOnce(snapshot({ phase: "prepared", planAcceptedParticipantIds: [A, B], readyParticipantIds: [A] }));

    await tool(client, "CoWorkReady").execute({ coWorkId: COWORK, epoch: 2, planHash: HASH }, new AbortController().signal);

    expect(client.coWorkAction).toHaveBeenNthCalledWith(1, { type: "cowork-plan-accept", coWorkId: COWORK, epoch: 2, planHash: HASH });
    expect(client.coWorkAction).toHaveBeenNthCalledWith(2, { type: "cowork-ready", coWorkId: COWORK, epoch: 2, planHash: HASH });
  });

  it("CoWorkReady records readiness even while another participant still reviews the plan", async () => {
    const client = fakeClient();
    (client.coWorkStatus as ReturnType<typeof vi.fn>).mockResolvedValue(snapshot({
      phase: "planning", planAcceptedParticipantIds: [B], readyParticipantIds: [],
    }));
    (client.coWorkAction as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(snapshot({ phase: "planning", planAcceptedParticipantIds: [A, B] }))
      .mockResolvedValueOnce(snapshot({ phase: "planning", planAcceptedParticipantIds: [A, B], readyParticipantIds: [A] }));

    await tool(client, "CoWorkReady").execute({ coWorkId: COWORK, epoch: 2, planHash: HASH }, new AbortController().signal);

    expect(client.coWorkAction).toHaveBeenNthCalledWith(2, { type: "cowork-ready", coWorkId: COWORK, epoch: 2, planHash: HASH });
  });

  it("CoWorkPlan submits a strict plan and CoWorkProgress exchanges bounded facts", async () => {
    const client = fakeClient();
    const plan: CoWorkPlan = {
      version: 1, coWorkId: COWORK, epoch: 2, goal: "ship together",
      participants: [{ palId: A, required: true }, { palId: B, required: true }],
      tasks: [{ id: "api", assigneeId: B, description: "change API", dependsOn: [] }],
    };
    await tool(client, "CoWorkPlan").execute({ plan }, new AbortController().signal);
    await tool(client, "CoWorkProgress").execute({ coWorkId: COWORK, target: B, detail: "schema landed" }, new AbortController().signal);
    expect(client.coWorkAction).toHaveBeenCalledWith({ type: "cowork-plan", plan });
    expect(client.sendChat).toHaveBeenCalledWith(B, "[co-work 40000000-0000-4000-8000-000000000001 progress] schema landed");
  });

  it("CoWorkComplete requires verification evidence or an explicit waiver", async () => {
    const client = fakeClient();
    (client.coWorkStatus as ReturnType<typeof vi.fn>).mockResolvedValue(snapshot({
      phase: "running", acceptedParticipantIds: [A, B], readyParticipantIds: [A, B],
    }));
    const complete = tool(client, "CoWorkComplete");
    expect(complete.inputSchema.safeParse({ coWorkId: COWORK, epoch: 2, planHash: HASH, passed: true, detail: "" }).success).toBe(false);
    expect(complete.inputSchema.safeParse({ coWorkId: COWORK, epoch: 2, planHash: HASH, passed: true, detail: "x".repeat(4 * 1024 + 1) }).success).toBe(false);
    await complete.execute({ coWorkId: COWORK, epoch: 2, planHash: HASH, passed: true, detail: "tests: 12 passed" }, new AbortController().signal);
    expect(client.coWorkAction).toHaveBeenCalledWith({ type: "cowork-complete", coWorkId: COWORK, epoch: 2, planHash: HASH, passed: true, detail: "tests: 12 passed" });
  });

  it("CoWorkIntegrate is owner-only and requires nonempty evidence", async () => {
    const client = fakeClient();
    const integrate = tool(client, "CoWorkIntegrate");
    expect(integrate.inputSchema.safeParse({ coWorkId: COWORK, epoch: 2, planHash: HASH, passed: true, evidence: "" }).success).toBe(false);
    expect(integrate.inputSchema.safeParse({ coWorkId: COWORK, epoch: 2, planHash: HASH, passed: true, evidence: "x".repeat(4 * 1024 + 1) }).success).toBe(false);
    (client.coWorkStatus as ReturnType<typeof vi.fn>).mockResolvedValue(snapshot({
      phase: "verifying", completedParticipantIds: [A, B], completionAssertions: [
        { participantId: A, passed: true, detail: "app tests pass" },
        { participantId: B, passed: true, detail: "api tests pass" },
      ],
    }));
    await integrate.execute({ coWorkId: COWORK, epoch: 2, planHash: HASH, passed: true, evidence: "cross-project tests pass" }, new AbortController().signal);
    expect(client.integrateCoWork).toHaveBeenCalledWith({
      coWorkId: COWORK, epoch: 2, planHash: HASH, passed: true, evidence: "cross-project tests pass",
    });

    const nonOwnerTools = createPalsTools(client, { selfId: B });
    const nonOwner = nonOwnerTools.find(({ name }) => name === "CoWorkIntegrate")!;
    await expect(nonOwner.execute({
      coWorkId: COWORK, epoch: 2, planHash: HASH, passed: true, evidence: "tests pass",
    }, new AbortController().signal)).rejects.toThrow(/owner/i);
  });

  it("prevents observers and not-ready participants from invoking lifecycle mutations", async () => {
    const observerClient = fakeClient();
    (observerClient.coWorkStatus as ReturnType<typeof vi.fn>).mockResolvedValue(snapshot({
      phase: "planning",
      participants: [{ palId: A, required: false }, { palId: B, required: true }],
      integrationOwnerId: B,
    }));
    const observerTools = createPalsTools(observerClient, { selfId: A });
    const observerTool = (name: string) => observerTools.find((candidate) => candidate.name === name)!;
    const observerPlan: CoWorkPlan = {
      version: 1, coWorkId: COWORK, epoch: 2, goal: "coordinate",
      participants: [{ palId: A, required: false }, { palId: B, required: true }],
      tasks: [{ id: "api", assigneeId: B, description: "change API", dependsOn: [] }],
    };

    await expect(observerTool("CoWorkPlan").execute({ plan: observerPlan }, new AbortController().signal)).rejects.toThrow(/observer|required/i);
    await expect(observerTool("CoWorkReady").execute({ coWorkId: COWORK, epoch: 2, planHash: HASH }, new AbortController().signal)).rejects.toThrow(/observer|required/i);
    await expect(observerTool("CoWorkComplete").execute({
      coWorkId: COWORK, epoch: 2, planHash: HASH, passed: false, detail: "force failure",
    }, new AbortController().signal)).rejects.toThrow(/observer|required/i);
    expect(observerClient.coWorkAction).not.toHaveBeenCalled();

    const notReadyClient = fakeClient();
    (notReadyClient.coWorkStatus as ReturnType<typeof vi.fn>).mockResolvedValue(snapshot({
      phase: "running", acceptedParticipantIds: [A, B], readyParticipantIds: [B],
    }));
    await expect(tool(notReadyClient, "CoWorkComplete").execute({
      coWorkId: COWORK, epoch: 2, planHash: HASH, passed: true, detail: "tests pass",
    }, new AbortController().signal)).rejects.toThrow(/ready/i);
    expect(notReadyClient.coWorkAction).not.toHaveBeenCalled();
  });
});
