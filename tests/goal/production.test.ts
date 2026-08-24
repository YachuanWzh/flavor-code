import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

import { createProductionRuntime } from "../../src/production.js";
import { SessionStore } from "../../src/session/store.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it("persists a detailed neutral /goal timeline while the worker is still running", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "flavor-goal-production-"));
  roots.push(workspace);
  const pluginRoot = join(workspace, ".flavor", "plugins", "goal-capture");
  await mkdir(pluginRoot, { recursive: true });
  await writeFile(join(workspace, "package.json"), JSON.stringify({
    name: "goal-fixture", private: true, scripts: { test: "node -e \"console.log('verified')\"" },
  }));
  await writeFile(join(workspace, ".flavor", "flavor.json"), JSON.stringify({
    memory: { enabled: false },
    providers: { capture: { type: "plugin", defaultModel: "main", cheapModel: "cheap" } },
    agents: { main: { model: "capture:main" }, subagent: { model: "capture:cheap" } },
  }));
  await writeFile(join(pluginRoot, "flavor-plugin.json"), JSON.stringify({
    name: "goal-capture", version: "1.0.0", apiVersion: "1", main: "index.mjs", permissions: [],
    contributes: { commands: [], tools: [], hooks: [], skillRoots: [], modelAdapters: [{ name: "capture" }] },
  }));
  await writeFile(join(pluginRoot, "index.mjs"), `export function activate(ctx) {
    ctx.registerModelAdapter("capture", { async *stream(request) {
      const prompt = request.messages.at(-1)?.content ?? "";
      if (prompt.includes("goal planner")) {
        yield { type: "text", text: JSON.stringify({
          kind: "code-change",
          criteria: [{ id: 1, description: "works", type: "gating" }],
          verificationPlan: "inspect the result",
          nonGoals: [],
          assumedScope: [],
        }) };
        yield { type: "done", usage: { inputTokens: 1, outputTokens: 1 } };
        return;
      }
      if (prompt.includes("adversarial verifier")) {
        yield { type: "text", text: JSON.stringify({ refuted: false, gaps: [] }) };
        yield { type: "done", usage: { inputTokens: 1, outputTokens: 1 } };
        return;
      }
      yield { type: "text", text: "worker began" };
      await new Promise((resolve) => setTimeout(resolve, 500));
      yield { type: "text", text: "worker detail" };
      yield { type: "done", usage: { inputTokens: 3, outputTokens: 2 } };
    }});
  }`);

  const outputs: Array<{ type: string; message?: string }> = [];
  const runtime = await createProductionRuntime({
    workspace,
    home: workspace,
    environment: {},
    approvalPolicy: "deny",
    pluginSandbox: false,
    output: (event) => outputs.push(event as { type: string; message?: string }),
  });
  try {
    const submission = runtime.session.submit("/goal fix it");
    await vi.waitFor(async () => expect(await readFile(
      join(workspace, ".flavor", "sessions", `${runtime.sessionId}.jsonl`), "utf8",
    )).toContain("worker began"), { timeout: 10_000 });

    const rawInFlight = await readFile(
      join(workspace, ".flavor", "sessions", `${runtime.sessionId}.jsonl`),
      "utf8",
    );
    const active = rawInFlight.trim().split("\n").slice(1)
      .map((line) => JSON.parse(line) as { active?: { prompt: string; assistantText: string } })
      .find((record) => record.active !== undefined)?.active;
    expect(active).toMatchObject({ prompt: "/goal fix it" });
    expect(active?.assistantText).toContain("worker began");
    expect(outputs.some((event) => event.type === "warning")).toBe(false);
    expect(outputs.some((event) => event.type === "notice")).toBe(true);

    await submission;

    const saved = await new SessionStore({ workspace }).load(runtime.sessionId);
    expect(saved.timeline.state.completed.at(-1)?.assistantText).toContain("worker detail");
    const goalFiles = await readdir(join(workspace, ".flavor", "goals"));
    expect(goalFiles).toHaveLength(1);
    expect(JSON.parse(await readFile(join(workspace, ".flavor", "goals", goalFiles[0]!), "utf8")))
      .toMatchObject({ phase: "complete", status: "achieved", workerRounds: 1, verifyRounds: 1 });
  } finally {
    await runtime.dispose();
  }
}, 15_000);
