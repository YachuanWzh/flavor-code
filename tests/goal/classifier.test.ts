import { describe, expect, it } from "vitest";

import { runClassifier } from "../../src/goal/classifier.js";
import type { EvidencePacket, Plan } from "../../src/goal/types.js";
import { ModelRegistry } from "../../src/models/registry.js";
import type { ModelAdapter } from "../../src/models/types.js";

const plan: Plan = {
  kind: "code-change",
  criteria: [{ id: 1, description: "Tests pass", type: "gating" }],
  verificationPlan: "Run tests",
  nonGoals: [], assumedScope: [],
};
const evidence: EvidencePacket = {
  objective: "implement safely",
  changedFiles: ["src/a.ts"],
  planFile: null,
  finalResponse: "done",
  priorGaps: "(none)",
  contractHash: "a".repeat(64),
  workspaceDiffHash: "b".repeat(64),
  workspaceStatus: [" M src/a.ts"],
  hostVerification: { passed: true, summary: "tests passed", commands: [] },
};

describe("goal classifier", () => {
  it("fails closed when skeptic output cannot be validated", async () => {
    const adapter: ModelAdapter = {
      async *stream() {
        yield { type: "text", text: "not-json" };
        yield { type: "done", usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };
    const registry = new ModelRegistry().register("invalid", adapter);

    await expect(runClassifier(evidence, plan, {
      registry, modelId: "invalid:model", skepticCount: 3, workspace: process.cwd(),
    })).resolves.toMatchObject({ type: "blocked", reason: expect.stringMatching(/unavailable|invalid/i) });
  });

  it("places deterministic host verification in every skeptic prompt", async () => {
    const prompts: string[] = [];
    const adapter: ModelAdapter = {
      async *stream(request) {
        prompts.push(String(request.messages[0]?.content));
        yield { type: "text", text: '{"refuted":false,"gaps":[]}' };
        yield { type: "done", usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };
    const registry = new ModelRegistry().register("capture", adapter);
    await runClassifier(evidence, plan, { registry, modelId: "capture:model", skepticCount: 1, workspace: process.cwd() });

    expect(prompts[0]).toContain("Host verification");
    expect(prompts[0]).toContain("tests passed");
    expect(prompts[0]).toContain(evidence.contractHash);
  });
});
