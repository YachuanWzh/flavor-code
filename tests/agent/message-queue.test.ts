import { describe, expect, it } from "vitest";

import { AgentMessageQueue } from "../../src/agent/message-queue.js";

describe("AgentMessageQueue", () => {
  it("drains steering and follow-up independently in FIFO order", () => {
    const queue = new AgentMessageQueue();
    queue.enqueue("steer", "first");
    queue.enqueue("followUp", "later");
    queue.enqueue("steer", "second");

    expect(queue.drain("steer")).toEqual(["first"]);
    expect(queue.snapshot()).toEqual({ steering: ["second"], followUp: ["later"] });
    expect(queue.drain("followUp")).toEqual(["later"]);
  });

  it("supports draining all messages and returns immutable snapshots", () => {
    const queue = new AgentMessageQueue({ steeringMode: "all", followUpMode: "all" });
    queue.enqueue("steer", "one");
    queue.enqueue("steer", "two");
    const snapshot = queue.snapshot();

    expect(queue.drain("steer")).toEqual(["one", "two"]);
    expect(snapshot.steering).toEqual(["one", "two"]);
    expect(queue.snapshot().steering).toEqual([]);
  });

  it("clears and returns all pending messages", () => {
    const queue = new AgentMessageQueue();
    queue.enqueue("steer", "change");
    queue.enqueue("followUp", "next");

    expect(queue.clear()).toEqual({ steering: ["change"], followUp: ["next"] });
    expect(queue.hasPending).toBe(false);
  });

  it("rejects empty messages", () => {
    const queue = new AgentMessageQueue();
    expect(() => queue.enqueue("steer", "  ")).toThrow(/empty/i);
  });
});
