import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  artifactRef,
  beginDeliveryNode,
  completeDeliveryNode,
  createDeliveryRun,
  initializeDeliveryRun,
  readDeliveryRun,
  updateDeliveryRun,
  type DeliveryNodeId,
  type E2eDeliveryRun,
} from "../../src/e2e/delivery-run.js";

const time = (minute: number) => new Date(`2026-08-13T10:${String(minute).padStart(2, "0")}:00.000Z`);

function complete(run: E2eDeliveryRun, node: DeliveryNodeId, minute: number, value = node): E2eDeliveryRun {
  const started = beginDeliveryNode(run, node, [], time(minute));
  return completeDeliveryNode(started, node, [artifactRef(`${node}.json`, value, time(minute + 1))], time(minute + 1));
}

describe("E2E seven-node delivery run", () => {
  it("enforces dependencies and records attempts", () => {
    let run = createDeliveryRun("merchant-console", artifactRef("requirement.txt", "经营后台", time(0)), time(0));
    expect(() => beginDeliveryNode(run, "design", [], time(1))).toThrow(/dependency.*prd/i);

    run = complete(run, "prd", 1);
    expect(run.nodes.prd).toMatchObject({ status: "succeeded", attempt: 1 });
    run = beginDeliveryNode(run, "prd", [], time(3));
    expect(run.nodes.prd).toMatchObject({ status: "running", attempt: 2 });
  });

  it("marks every transitive downstream node stale when an upstream output changes", () => {
    let run = createDeliveryRun("merchant-console", artifactRef("requirement.txt", "经营后台", time(0)), time(0));
    for (const [index, node] of (["prd", "design", "d2c", "api", "acceptance", "delivery"] as DeliveryNodeId[]).entries()) {
      run = complete(run, node, index * 2 + 1);
    }
    run = beginDeliveryNode(run, "prd", [], time(20));
    run = completeDeliveryNode(run, "prd", [artifactRef("prd.md", "changed", time(21))], time(21));

    expect(run.nodes.prd.status).toBe("succeeded");
    for (const node of ["design", "d2c", "api", "acceptance", "delivery"] as const) {
      expect(run.nodes[node].status).toBe("stale");
    }
  });

  it("persists with expected-revision CAS and recovers the previous valid backup", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "flavor-delivery-run-"));
    const initial = createDeliveryRun("merchant-console", artifactRef("requirement.txt", "经营后台", time(0)), time(0));
    const stored = await initializeDeliveryRun(workspace, initial);
    const updated = await updateDeliveryRun(workspace, stored.task, stored.revision, (current) => complete(current, "prd", 1));
    expect(updated.revision).toBe(stored.revision + 1);

    await expect(updateDeliveryRun(workspace, stored.task, stored.revision, (current) => current))
      .rejects.toThrow(/STALE_REVISION/);

    const path = join(workspace, ".flavor", "d2c", stored.task, "delivery-run.json");
    await writeFile(path, "{broken");
    await expect(readDeliveryRun(workspace, stored.task)).resolves.toMatchObject({ revision: stored.revision });
  });
});
