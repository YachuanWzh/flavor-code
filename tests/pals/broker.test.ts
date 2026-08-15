import { describe, expect, it } from "vitest";

import {
  BrokerStateError,
  PalBrokerState,
  canonicalPlanHash,
  type PalBrokerStateOptions,
} from "../../src/pals/broker.js";
import type { CoWorkPlan } from "../../src/pals/protocol.js";

const A = "10000000-0000-4000-8000-000000000001";
const B = "10000000-0000-4000-8000-000000000002";
const C = "10000000-0000-4000-8000-000000000003";
const O = "10000000-0000-4000-8000-000000000004";
const COWORK = "40000000-0000-4000-8000-000000000001";
const COWORK_2 = "40000000-0000-4000-8000-000000000002";
const COWORK_3 = "40000000-0000-4000-8000-000000000003";

function createBroker(options: PalBrokerStateOptions = {}) {
  const broker = new PalBrokerState(options);
  broker.register({ id: A, alias: "app", projectPath: "/work/app" });
  broker.register({ id: B, alias: "api", projectPath: "/work/api" });
  return broker;
}

function expectCode(action: () => unknown, code: BrokerStateError["code"]): void {
  try {
    action();
    throw new Error("Expected BrokerStateError");
  } catch (error) {
    expect(error).toBeInstanceOf(BrokerStateError);
    expect((error as BrokerStateError).code).toBe(code);
  }
}

function plan(epoch = 1): CoWorkPlan {
  return {
    version: 1,
    coWorkId: COWORK,
    epoch,
    goal: "ship coordinated API and app changes",
    participants: [
      { palId: A, required: true },
      { palId: B, required: true },
      { palId: C, required: true },
      { palId: O, required: false },
    ],
    tasks: [
      { id: "api", assigneeId: B, description: "change API", dependsOn: [] },
      { id: "app", assigneeId: A, description: "adapt app", dependsOn: ["api"] },
      { id: "tests", assigneeId: C, description: "integration tests", dependsOn: ["api", "app"] },
    ],
  };
}

function planningBroker() {
  const broker = createBroker();
  broker.register({ id: C, alias: "tests", projectPath: "/work/tests" });
  broker.register({ id: O, alias: "observer", projectPath: "/work/docs" });
  broker.proposeCoWork(A, {
    coWorkId: COWORK,
    goal: "ship coordinated API and app changes",
    participants: plan().participants,
  });
  broker.acceptCoWork(B, COWORK, 1);
  broker.acceptCoWork(C, COWORK, 1);
  return broker;
}

function fullBrokerWithTerminal() {
  const broker = createBroker({ maxCoWorks: 2 });
  const terminalProposal = broker.proposeCoWork(A, {
    coWorkId: COWORK,
    goal: "completed historical coordination",
    participants: [{ palId: A, required: true }, { palId: B, required: true }],
  });
  const terminalCancellation = broker.cancelCoWork(A, COWORK, "historical work cancelled");
  const activeProposal = broker.proposeCoWork(A, {
    coWorkId: COWORK_2,
    goal: "active coordination",
    participants: [{ palId: A, required: true }, { palId: B, required: true }],
  });
  return { broker, terminalProposal, terminalCancellation, activeProposal };
}

describe("PalBrokerState presence", () => {
  it("does not permit configuration above the protocol active-pal bound", () => {
    expect(() => new PalBrokerState({ maxPals: 17 })).toThrow(/maxPals.*16/i);
  });
  it("lists every registered instance including the caller and protects internal state", () => {
    const broker = createBroker();
    const listed = broker.list();
    expect(listed.map((pal) => pal.id)).toEqual([A, B]);

    listed[0]!.alias = "mutated";
    expect(broker.list()[0]!.alias).toBe("app");
  });

  it("enforces aliases case-insensitively", () => {
    const broker = createBroker();
    expectCode(
      () => broker.register({ id: C, alias: "API", projectPath: "/work/other-api" }),
      "alias-conflict",
    );
  });

  it("resolves alias, full UUID, or a unique UUID prefix and fails closed when ambiguous", () => {
    const broker = createBroker();
    const D = "10000000-0000-4000-8000-000000000099";
    broker.register({ id: D, alias: "worker", projectPath: "/work/worker" });

    expect(broker.resolveTarget("API").id).toBe(B);
    expect(broker.resolveTarget(A).id).toBe(A);
    expect(broker.resolveTarget("10000000-0000-4000-8000-00000000009").id).toBe(D);
    expectCode(() => broker.resolveTarget("10000000"), "ambiguous-target");
    expectCode(() => broker.resolveTarget("missing"), "not-found");
  });

  it("expires stale heartbeats and removes explicit disconnects", () => {
    let now = 1_000;
    const broker = createBroker({ now: () => now, heartbeatTimeoutMs: 100 });
    now = 1_075;
    broker.heartbeat(B);
    now = 1_125;
    expect(broker.list().map((pal) => pal.id)).toEqual([B]);

    broker.disconnect(B);
    expect(broker.list()).toEqual([]);
  });
});

describe("PalBrokerState routing", () => {
  it("deduplicates message IDs with bounded memory", () => {
    const broker = createBroker({ dedupLimit: 2 });
    const send = (messageId: string) => broker.routeChat(A, { messageId, target: "api", message: messageId });
    const first = "20000000-0000-4000-8000-000000000001";
    const second = "20000000-0000-4000-8000-000000000002";
    const third = "20000000-0000-4000-8000-000000000003";

    expect(send(first).receipt.status).toBe("delivered");
    expect(send(first).receipt.status).toBe("duplicate");
    send(second);
    send(third);
    expect(send(first).receipt.status).toBe("delivered");
  });

  it("routes task work to exactly the resolved target with an authoritative sender", () => {
    const broker = createBroker({ idFactory: () => "30000000-0000-4000-8000-000000000001" });
    broker.register({ id: C, alias: "tests", projectPath: "/work/tests" });
    const result = broker.routeTask(A, {
      messageId: "20000000-0000-4000-8000-000000000010",
      target: "tests",
      goal: "start integration tests",
    });

    expect(result.receipt.recipientIds).toEqual([C]);
    expect(result.deliveries).toHaveLength(1);
    expect(result.deliveries[0]).toEqual({
      recipientId: C,
      event: {
        version: 1,
        type: "task-event",
        messageId: "20000000-0000-4000-8000-000000000010",
        taskId: "30000000-0000-4000-8000-000000000001",
        senderId: A,
        recipientId: C,
        status: "accepted",
        detail: "start integration tests",
      },
    });
  });
});

describe("PalBrokerState co-work barriers", () => {
  it.each([
    ["undersized", [{ palId: A, required: true }], "invalid-transition"],
    ["inactive", [{ palId: A, required: true }, { palId: C, required: true }], "not-found"],
    ["duplicate", [{ palId: A, required: true }, { palId: A, required: true }], "invalid-transition"],
  ] as const)("rejects a %s roster at capacity without evicting or rewriting history", (_kind, participants, code) => {
    const { broker, terminalProposal, terminalCancellation, activeProposal } = fullBrokerWithTerminal();

    expectCode(() => broker.proposeCoWork(A, {
      coWorkId: COWORK_3,
      goal: "invalid candidate must not mutate history",
      participants: [...participants],
    }), code);

    expect(broker.getCoWork(COWORK)).toEqual(terminalCancellation.snapshot);
    expect(broker.getCoWork(COWORK_2)).toEqual(activeProposal.snapshot);
    expect(terminalProposal.events).toEqual([expect.objectContaining({ action: "PROPOSE", coWorkId: COWORK })]);
    expect(terminalCancellation.events).toEqual([expect.objectContaining({ action: "CANCEL", coWorkId: COWORK })]);
    expectCode(() => broker.getCoWork(COWORK_3), "not-found");
  });

  it("evicts exactly one terminal co-work only after a valid proposal is fully prepared", () => {
    const { broker, activeProposal } = fullBrokerWithTerminal();

    const proposed = broker.proposeCoWork(A, {
      coWorkId: COWORK_3,
      goal: "validated replacement coordination",
      participants: [{ palId: A, required: true }, { palId: B, required: true }],
    });

    expectCode(() => broker.getCoWork(COWORK), "not-found");
    expect(broker.getCoWork(COWORK_2)).toEqual(activeProposal.snapshot);
    expect(broker.getCoWork(COWORK_3)).toEqual(proposed.snapshot);
  });

  it("rejects a valid proposal at capacity without mutation when no terminal co-work exists", () => {
    const broker = createBroker({ maxCoWorks: 2 });
    const first = broker.proposeCoWork(A, {
      coWorkId: COWORK,
      goal: "first active coordination",
      participants: [{ palId: A, required: true }, { palId: B, required: true }],
    });
    const second = broker.proposeCoWork(A, {
      coWorkId: COWORK_2,
      goal: "second active coordination",
      participants: [{ palId: A, required: true }, { palId: B, required: true }],
    });

    expectCode(() => broker.proposeCoWork(A, {
      coWorkId: COWORK_3,
      goal: "third active coordination",
      participants: [{ palId: A, required: true }, { palId: B, required: true }],
    }), "capacity");

    expect(broker.getCoWork(COWORK)).toEqual(first.snapshot);
    expect(broker.getCoWork(COWORK_2)).toEqual(second.snapshot);
    expectCode(() => broker.getCoWork(COWORK_3), "not-found");
  });

  it("rejects duplicate or self-only participant rosters at the state boundary", () => {
    const broker = createBroker();
    expectCode(() => broker.proposeCoWork(A, {
      coWorkId: COWORK,
      goal: "ship coordinated API and app changes",
      participants: [{ palId: A, required: true }],
    }), "invalid-transition");
    expectCode(() => broker.proposeCoWork(A, {
      coWorkId: COWORK,
      goal: "ship coordinated API and app changes",
      participants: [{ palId: A, required: true }, { palId: A, required: true }],
    }), "invalid-transition");
  });

  it("attributes transitions and makes cancellation terminal without an END event", () => {
    const broker = createBroker();
    const proposed = broker.proposeCoWork(A, {
      coWorkId: COWORK,
      goal: "ship coordinated API and app changes",
      participants: [{ palId: A, required: true }, { palId: B, required: true }],
    });
    expect(proposed.events).toEqual([expect.objectContaining({ action: "PROPOSE", actorId: A })]);

    const cancelled = broker.cancelCoWork(B, COWORK, "dependency withdrawn");
    expect(cancelled.snapshot.phase).toBe("cancelled");
    expect(cancelled.events).toEqual([expect.objectContaining({ action: "CANCEL", actorId: B })]);
    expect(cancelled.events).not.toEqual([expect.objectContaining({ action: "END" })]);
    expectCode(() => broker.acceptCoWork(A, COWORK, 1), "invalid-transition");
  });

  it("moves proposed to planning only after all required participants accept", () => {
    const broker = createBroker();
    broker.register({ id: C, alias: "tests", projectPath: "/work/tests" });
    broker.register({ id: O, alias: "observer", projectPath: "/work/docs" });
    expect(broker.proposeCoWork(A, {
      coWorkId: COWORK,
      goal: "ship coordinated API and app changes",
      participants: plan().participants,
    }).snapshot).toMatchObject({ phase: "proposed", acceptedParticipantIds: [A] });

    expect(broker.acceptCoWork(B, COWORK, 1).snapshot.phase).toBe("proposed");
    expect(broker.acceptCoWork(C, COWORK, 1).snapshot.phase).toBe("planning");
  });

  it("requires acceptance of the exact canonical plan hash before prepared", () => {
    const broker = planningBroker();
    const submitted = broker.submitCoWorkPlan(A, plan());
    const hash = canonicalPlanHash(plan());
    expect(submitted.snapshot).toMatchObject({ phase: "planning", planHash: hash });
    expectCode(
      () => broker.acceptCoWorkPlan(B, { coWorkId: COWORK, epoch: 1, planHash: "0".repeat(64) }),
      "invalid-transition",
    );

    broker.acceptCoWorkPlan(A, { coWorkId: COWORK, epoch: 1, planHash: hash });
    broker.acceptCoWorkPlan(B, { coWorkId: COWORK, epoch: 1, planHash: hash });
    expect(broker.acceptCoWorkPlan(C, { coWorkId: COWORK, epoch: 1, planHash: hash }).snapshot.phase)
      .toBe("prepared");
  });

  it("emits START only after every required participant is READY", () => {
    const broker = planningBroker();
    const hash = canonicalPlanHash(plan());
    broker.submitCoWorkPlan(A, plan());
    for (const palId of [A, B, C]) broker.acceptCoWorkPlan(palId, { coWorkId: COWORK, epoch: 1, planHash: hash });

    broker.markCoWorkReady(A, { coWorkId: COWORK, epoch: 1, planHash: hash });
    broker.markCoWorkReady(B, { coWorkId: COWORK, epoch: 1, planHash: hash });
    const result = broker.markCoWorkReady(C, { coWorkId: COWORK, epoch: 1, planHash: hash });
    expect(result.snapshot.phase).toBe("running");
    expect(result.events).toEqual([expect.objectContaining({ action: "START", epoch: 1, planHash: hash })]);
  });

  it("records an early ready intent and emits exactly one START after the last peer accepts and becomes ready", () => {
    const broker = createBroker();
    const twoPeerPlan: CoWorkPlan = {
      version: 1,
      coWorkId: COWORK,
      epoch: 1,
      goal: "ship coordinated API and app changes",
      participants: [{ palId: A, required: true }, { palId: B, required: true }],
      tasks: [
        { id: "api", assigneeId: B, description: "change API", dependsOn: [] },
        { id: "app", assigneeId: A, description: "adapt app", dependsOn: ["api"] },
      ],
    };
    broker.proposeCoWork(A, { coWorkId: COWORK, goal: twoPeerPlan.goal, participants: twoPeerPlan.participants });
    broker.acceptCoWork(B, COWORK, 1);
    const hash = canonicalPlanHash(twoPeerPlan);
    broker.submitCoWorkPlan(A, twoPeerPlan);

    broker.acceptCoWorkPlan(A, { coWorkId: COWORK, epoch: 1, planHash: hash });
    const early = broker.markCoWorkReady(A, { coWorkId: COWORK, epoch: 1, planHash: hash });
    expect(early.snapshot).toMatchObject({ phase: "planning", readyParticipantIds: [A] });
    expect(early.events).toEqual([]);
    expect(broker.markCoWorkReady(A, { coWorkId: COWORK, epoch: 1, planHash: hash }).events).toEqual([]);

    expect(broker.acceptCoWorkPlan(B, { coWorkId: COWORK, epoch: 1, planHash: hash }).snapshot.phase).toBe("prepared");
    const started = broker.markCoWorkReady(B, { coWorkId: COWORK, epoch: 1, planHash: hash });
    expect(started.snapshot.phase).toBe("running");
    expect(started.events).toEqual([expect.objectContaining({ action: "START" })]);
    expect(broker.markCoWorkReady(B, { coWorkId: COWORK, epoch: 1, planHash: hash }).events).toEqual([]);
  });

  it("reaches verifying after valid local completions and completed only after integration passes", () => {
    const broker = planningBroker();
    const hash = canonicalPlanHash(plan());
    broker.submitCoWorkPlan(A, plan());
    for (const palId of [A, B, C]) broker.acceptCoWorkPlan(palId, { coWorkId: COWORK, epoch: 1, planHash: hash });
    for (const palId of [A, B, C]) broker.markCoWorkReady(palId, { coWorkId: COWORK, epoch: 1, planHash: hash });
    broker.completeCoWork(A, { coWorkId: COWORK, epoch: 1, planHash: hash, passed: true, detail: "app tests pass" });
    broker.completeCoWork(B, { coWorkId: COWORK, epoch: 1, planHash: hash, passed: true, detail: "api tests pass" });
    const verifying = broker.completeCoWork(C, { coWorkId: COWORK, epoch: 1, planHash: hash, passed: true, detail: "integration fixture passes" });
    expect(verifying.snapshot.phase).toBe("verifying");
    expect(verifying.snapshot.integrationOwnerId).toBe(A);
    expect(verifying.snapshot.completionAssertions).toEqual([
      { participantId: A, passed: true, detail: "app tests pass" },
      { participantId: B, passed: true, detail: "api tests pass" },
      { participantId: C, passed: true, detail: "integration fixture passes" },
    ]);

    expectCode(() => broker.integrateCoWork(B, {
      coWorkId: COWORK,
      epoch: 1,
      planHash: hash,
      passed: true,
      evidence: "cross-project tests pass",
    }), "invalid-transition");

    const integrated = broker.integrateCoWork(A, {
      coWorkId: COWORK,
      epoch: 1,
      planHash: hash,
      passed: true,
      evidence: "cross-project tests pass",
    });
    expect(integrated.snapshot.phase).toBe("completed");
    expect(integrated.events).toEqual([expect.objectContaining({ action: "END", epoch: 1, planHash: hash })]);
    expectCode(() => broker.integrateCoWork(A, {
      coWorkId: COWORK, epoch: 1, planHash: hash, passed: true, evidence: "replay",
    }), "invalid-transition");
  });

  it("broadcasts FAIL for local and integration failures without duplicate terminal events", () => {
    const localBroker = planningBroker();
    const hash = canonicalPlanHash(plan());
    localBroker.submitCoWorkPlan(A, plan());
    for (const palId of [A, B, C]) localBroker.acceptCoWorkPlan(palId, { coWorkId: COWORK, epoch: 1, planHash: hash });
    for (const palId of [A, B, C]) localBroker.markCoWorkReady(palId, { coWorkId: COWORK, epoch: 1, planHash: hash });
    const failed = localBroker.completeCoWork(B, {
      coWorkId: COWORK, epoch: 1, planHash: hash, passed: false, detail: "api tests failed",
    });
    expect(failed.snapshot).toMatchObject({
      phase: "failed",
      completionAssertions: [{ participantId: B, passed: false, detail: "api tests failed" }],
    });
    expect(failed.events).toEqual([expect.objectContaining({ action: "FAIL", actorId: B })]);
    expectCode(() => localBroker.completeCoWork(B, {
      coWorkId: COWORK, epoch: 1, planHash: hash, passed: false, detail: "replay",
    }), "invalid-transition");

    const integrationBroker = planningBroker();
    integrationBroker.submitCoWorkPlan(A, plan());
    for (const palId of [A, B, C]) integrationBroker.acceptCoWorkPlan(palId, { coWorkId: COWORK, epoch: 1, planHash: hash });
    for (const palId of [A, B, C]) integrationBroker.markCoWorkReady(palId, { coWorkId: COWORK, epoch: 1, planHash: hash });
    for (const palId of [A, B, C]) integrationBroker.completeCoWork(palId, {
      coWorkId: COWORK, epoch: 1, planHash: hash, passed: true, detail: `${palId} tests pass`,
    });
    const integrationFailed = integrationBroker.integrateCoWork(A, {
      coWorkId: COWORK, epoch: 1, planHash: hash, passed: false, evidence: "contract mismatch",
    });
    expect(integrationFailed.snapshot).toMatchObject({ phase: "failed", integration: { passed: false, evidence: "contract mismatch" } });
    expect(integrationFailed.events).toEqual([expect.objectContaining({ action: "FAIL", actorId: A })]);
  });

  it("invalidates stale ready and completion state when a plan is revised", () => {
    const broker = planningBroker();
    const firstHash = canonicalPlanHash(plan());
    broker.submitCoWorkPlan(A, plan());
    for (const palId of [A, B, C]) broker.acceptCoWorkPlan(palId, { coWorkId: COWORK, epoch: 1, planHash: firstHash });
    broker.markCoWorkReady(A, { coWorkId: COWORK, epoch: 1, planHash: firstHash });

    const revised = plan(2);
    revised.tasks[0]!.description = "change API v2";
    const result = broker.submitCoWorkPlan(B, revised);
    expect(result.snapshot).toMatchObject({
      epoch: 2,
      phase: "planning",
      readyParticipantIds: [],
      completedParticipantIds: [],
      completionAssertions: [],
      planAcceptedParticipantIds: [],
    });
    expectCode(
      () => broker.markCoWorkReady(A, { coWorkId: COWORK, epoch: 1, planHash: firstHash }),
      "stale-epoch",
    );
  });

  it("rejects an aggregate-oversize assertion transactionally and permits shorter retry", () => {
    const broker = createBroker();
    broker.register({ id: C, alias: "tests", projectPath: "/work/tests" });
    broker.register({ id: O, alias: "release", projectPath: "/work/release" });
    const participants = [A, B, C, O].map((palId) => ({ palId, required: true }));
    const fourPeerPlan: CoWorkPlan = {
      version: 1, coWorkId: COWORK, epoch: 1, goal: "verify four projects", participants,
      tasks: participants.map(({ palId }, index) => ({ id: `task-${index}`, assigneeId: palId, description: `verify ${index}`, dependsOn: [] })),
    };
    broker.proposeCoWork(A, { coWorkId: COWORK, goal: fourPeerPlan.goal, participants });
    for (const palId of [B, C, O]) broker.acceptCoWork(palId, COWORK, 1);
    const hash = canonicalPlanHash(fourPeerPlan);
    broker.submitCoWorkPlan(A, fourPeerPlan);
    for (const palId of [A, B, C, O]) broker.acceptCoWorkPlan(palId, { coWorkId: COWORK, epoch: 1, planHash: hash });
    for (const palId of [A, B, C, O]) broker.markCoWorkReady(palId, { coWorkId: COWORK, epoch: 1, planHash: hash });
    for (const palId of [A, B, C]) broker.completeCoWork(palId, {
      coWorkId: COWORK, epoch: 1, planHash: hash, passed: true, detail: "x".repeat(4_000),
    });
    const before = broker.getCoWork(COWORK);

    expect(() => broker.completeCoWork(O, {
      coWorkId: COWORK, epoch: 1, planHash: hash, passed: false, detail: "y".repeat(400),
    })).toThrow(/12|aggregate|assertion/i);
    expect(broker.getCoWork(COWORK)).toEqual(before);
    expect(broker.getCoWork(COWORK)).toMatchObject({ phase: "running", completedParticipantIds: [A, B, C] });

    const retried = broker.completeCoWork(O, {
      coWorkId: COWORK, epoch: 1, planHash: hash, passed: true, detail: "y".repeat(200),
    });
    expect(retried.snapshot.phase).toBe("verifying");
    expect(retried.events).toEqual([]);
  });

  it("keeps observers read-only and requires accepted ready participants for completion", () => {
    const broker = planningBroker();
    const hash = canonicalPlanHash(plan());
    broker.submitCoWorkPlan(A, plan());

    expectCode(() => broker.acceptCoWorkPlan(O, { coWorkId: COWORK, epoch: 1, planHash: hash }), "invalid-transition");
    expectCode(() => broker.markCoWorkReady(O, { coWorkId: COWORK, epoch: 1, planHash: hash }), "invalid-transition");
    expectCode(() => broker.completeCoWork(O, {
      coWorkId: COWORK, epoch: 1, planHash: hash, passed: false, detail: "observer forced failure",
    }), "invalid-transition");
    expect(broker.getCoWork(COWORK)).toMatchObject({ phase: "planning", completionAssertions: [] });

    expectCode(() => broker.completeCoWork(A, {
      coWorkId: COWORK, epoch: 1, planHash: hash, passed: true, detail: "too early",
    }), "invalid-transition");
  });

  it("selects a required integration owner and lets a sole required proposer start without acceptance deadlock", () => {
    const broker = createBroker();
    broker.register({ id: O, alias: "observer", projectPath: "/work/docs" });
    const participants = [{ palId: A, required: true }, { palId: O, required: false }];
    const proposal = broker.proposeCoWork(A, { coWorkId: COWORK, goal: "solo change with observer", participants });
    expect(proposal.snapshot).toMatchObject({ phase: "planning", integrationOwnerId: A, acceptedParticipantIds: [A] });

    const soloPlan: CoWorkPlan = {
      version: 1, coWorkId: COWORK, epoch: 1, goal: "solo change with observer", participants,
      tasks: [{ id: "solo", assigneeId: A, description: "implement and verify", dependsOn: [] }],
    };
    const planned = broker.submitCoWorkPlan(A, soloPlan);
    const hash = planned.snapshot.planHash!;
    broker.acceptCoWorkPlan(A, { coWorkId: COWORK, epoch: 1, planHash: hash });
    expect(broker.markCoWorkReady(A, { coWorkId: COWORK, epoch: 1, planHash: hash }).snapshot.phase).toBe("running");
    expect(broker.completeCoWork(A, {
      coWorkId: COWORK, epoch: 1, planHash: hash, passed: true, detail: "solo tests pass",
    }).snapshot.phase).toBe("verifying");
    expect(broker.integrateCoWork(A, {
      coWorkId: COWORK, epoch: 1, planHash: hash, passed: true, evidence: "observer-reviewed output",
    }).snapshot.phase).toBe("completed");

    const optionalProposer = createBroker();
    optionalProposer.register({ id: O, alias: "observer", projectPath: "/work/docs" });
    const optionalProposal = optionalProposer.proposeCoWork(O, {
      coWorkId: COWORK, goal: "required owner selection", participants: [{ palId: O, required: false }, { palId: A, required: true }],
    });
    expect(optionalProposal.snapshot.integrationOwnerId).toBe(A);
  });
});
