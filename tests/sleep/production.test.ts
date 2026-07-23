import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

import { createProductionRuntime } from "../../src/production.js";
import { SESSION_VERSION, SessionStore, type SessionDocument } from "../../src/session/store.js";

const roots: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  delete (globalThis as { __sleepModels?: string[] }).__sleepModels;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it("wires an enabled project midnight review to the configured cheap model", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "flavor-sleep-production-"));
  roots.push(workspace);
  const pluginRoot = join(workspace, ".flavor", "plugins", "sleep-capture");
  await mkdir(pluginRoot, { recursive: true });
  await writeFile(join(workspace, ".flavor", "flavor.json"), JSON.stringify({
    sleep: true,
    memory: { enabled: false },
    providers: { capture: { type: "plugin", defaultModel: "main", cheapModel: "cheap" } },
    agents: { main: { model: "capture:main" }, subagent: { model: "capture:cheap" } },
  }));
  await writeFile(join(pluginRoot, "flavor-plugin.json"), JSON.stringify({
    name: "sleep-capture", version: "1.0.0", apiVersion: "1", main: "index.mjs", permissions: [],
    contributes: { commands: [], tools: [], hooks: [], skillRoots: [], modelAdapters: [{ name: "capture" }] },
  }));
  await writeFile(join(pluginRoot, "index.mjs"), `export function activate(ctx) {
    ctx.registerModelAdapter("capture", { async *stream(request) {
      globalThis.__sleepModels ??= [];
      globalThis.__sleepModels.push(request.model);
      yield { type: "text", text: JSON.stringify({
        title: "项目复盘",
        taskSummary: ["完成项目任务"],
        executionReflection: ["测试驱动过程顺利"],
        decisionsAndLearnings: ["保留项目级隔离"],
        openQuestionsAndRisks: [],
        tomorrowPlan: ["继续验证"],
        toolUsage: { totalCalls: 3, shell: 1, fileRead: 1, fileWrite: 1, search: 0, lsp: 0, subagent: 0, other: 0 },
        tokenEstimate: { estimatedInput: 500, estimatedOutput: 100, notes: "测试估算" },
        humanIntervention: { approvalRequests: 0, questionsAsked: 0, summary: "" },
        qualityIndicators: { hallucinationAlerts: [], failuresAndRetries: [], codeChangeSummary: "", overallAssessment: "顺利" },
        knowledgeDeposits: { worthRemembering: [] },
      }) };
      yield { type: "done", usage: { inputTokens: 1, outputTokens: 1 } };
    }});
  }`);

  const updatedAt = new Date(2026, 6, 23, 12, 0, 0, 0);
  const document: SessionDocument = {
    version: SESSION_VERSION,
    sessionId: "session-sleep-target",
    createdAt: updatedAt.toISOString(),
    updatedAt: updatedAt.toISOString(),
    workspace: { path: workspace },
    conversation: { messages: [
      { role: "user", content: "实现项目睡眠整理" },
      { role: "assistant", content: "实现完成并通过测试" },
    ] },
    tasks: { states: {}, results: {} },
    models: { main: "capture:main", subagent: "capture:cheap" },
    permissionMode: "default",
    timeline: { version: 1, state: { completed: [], nextId: 1 } },
  };
  await new SessionStore({ workspace }).save(document);

  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 6, 23, 23, 59, 59, 900));
  const runtime = await createProductionRuntime({ workspace, home: workspace, environment: {}, output: () => {} });
  try {
    await vi.advanceTimersByTimeAsync(100);
    await vi.waitFor(() => expect((globalThis as { __sleepModels?: string[] }).__sleepModels).toEqual(["cheap"]));
    const reports = (await readdir(join(workspace, ".flavor", "sleep"))).filter((name) => name.endsWith(".md"));
    expect(reports).toEqual(["2026-07-23-项目复盘.md"]);
    expect(await readFile(join(workspace, ".flavor", "sleep", reports[0]!), "utf8"))
      .toContain("## 明日可能规划");
  } finally {
    await runtime.dispose();
  }
});

