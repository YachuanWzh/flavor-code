import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { ExpertAgentRegistry } from "../../src/agent/expert-agents.js";
import { generateExpertAgent } from "../../src/agent/expert-generator.js";
import { ModelRegistry } from "../../src/models/registry.js";
import type { ModelEvent, ModelRequest } from "../../src/models/types.js";
import type { ToolDefinition } from "../../src/tools/types.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

const tools = [
  { name: "Read", description: "Read a file" },
  { name: "Glob", description: "Find files" },
  { name: "Grep", description: "Search text" },
  { name: "Write", description: "Write a file" },
] as ToolDefinition<unknown>[];

const reviewDraft = {
  description: "审查代码正确性、回归风险与测试覆盖情况",
  permission: "readOnly", tools: ["Read", "Glob", "Grep"], maxIterations: 30,
  purpose: "独立审查指定代码改动，找出会影响用户的真实缺陷与遗漏的测试。",
  workflow: [
    "先定位变更文件及其调用方，确认预期行为和现有测试覆盖范围。",
    "逐项追踪关键分支、边界输入与错误处理，验证疑似缺陷是否可触发。",
    "按严重程度整理问题，附上对应文件、行号、触发条件和证据。",
  ],
  deliverables: [
    "逐条报告缺陷的严重程度、文件行号、失败机制与复现条件。",
    "指出缺失的测试场景；若未发现问题，说明审查范围与剩余不确定性。",
  ],
  boundaries: [
    "只读取项目内容，不修改文件、不执行会改变环境的命令。",
    "只报告有代码证据的问题，无法验证的猜测必须明确标注。",
  ],
};

function registryFor(outputs: unknown[], requests: ModelRequest[]): ModelRegistry {
  let index = 0;
  return new ModelRegistry().register("fake", {
    async *stream(request) {
      requests.push(request);
      const events: ModelEvent[] = [
        { type: "tool-call", id: `draft-${index}`, name: "CreateExpertAgent", input: outputs[index++] },
        { type: "done", usage: { inputTokens: 1, outputTokens: 1 } },
      ];
      yield* events;
    },
  });
}

describe("custom expert generation", () => {
  it("creates a substantive read-only review agent from a short natural-language request", async () => {
    const root = await mkdtemp(join(tmpdir(), "flavor-generated-agent-")); roots.push(root);
    const requests: ModelRequest[] = [];
    const generated = await generateExpertAgent({
      registry: registryFor([reviewDraft], requests), modelId: "fake:model", name: "cr-agent",
      request: "创建一个用于code review的agent", tools,
    });
    const saved = await new ExpertAgentRegistry(root, root).createGenerated("cr-agent", generated);
    expect(saved.permission).toBe("readOnly");
    expect(saved.tools).toEqual(["Read", "Glob", "Grep"]);
    expect(saved.instructions).toContain("## Workflow");
    expect(saved.instructions).toContain("文件行号");
    expect(await readFile(saved.path, "utf8")).toContain("permission: readOnly");
    expect(requests[0]?.messages.some((message) =>
      typeof message.content === "string" && message.content.includes("Read-only required: true"))).toBe(true);
  });

  it("rejects generic or over-privileged drafts without writing a file", async () => {
    const root = await mkdtemp(join(tmpdir(), "flavor-generated-agent-")); roots.push(root);
    const requests: ModelRequest[] = [];
    const bad = { ...reviewDraft, permission: "standard", tools: ["Read", "Write"],
      workflow: ["Inspect code", "Make changes", "Report results"] };
    await expect(generateExpertAgent({
      registry: registryFor([bad, bad], requests), modelId: "fake:model", name: "cr-agent",
      request: "创建一个用于code review的agent", tools,
    })).rejects.toThrow();
    expect(requests).toHaveLength(2);
    await expect(stat(join(root, ".flavor", "agents", "cr-agent.md"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
