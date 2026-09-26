import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { ExpertAgentRegistry } from "../../src/agent/expert-agents.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("ExpertAgentRegistry", () => {
  it("creates a usable project agent from a preset without overwriting existing definitions", async () => {
    const root = await mkdtemp(join(tmpdir(), "flavor-expert-create-")); roots.push(root);
    const registry = new ExpertAgentRegistry(root, root);
    const created = await registry.create("api-reviewer", "reviewer", "Check API compatibility");
    expect(created).toMatchObject({
      name: "api-reviewer", source: "project", description: "Check API compatibility",
      permission: "readOnly", tools: ["Read", "Glob", "Grep", "TaskOutput"],
    });
    expect(await readFile(created.path, "utf8")).toContain("Focus: Check API compatibility");
    await expect(registry.create("api-reviewer", "implementer")).rejects.toThrow("already exists");
    expect((await registry.get("api-reviewer")).permission).toBe("readOnly");
    expect((await registry.create("worker", "implementer")).permission).toBe("standard");
    await expect(registry.create("test-writer", "custom", "补齐认证模块的单元测试"))
      .rejects.toThrow("must be generated");
    const custom = await registry.createGenerated("db-auditor", {
      description: "审查数据库迁移与回滚风险", permission: "readOnly",
      tools: ["Read", "Grep"], maxIterations: 30,
      instructions: "## Purpose\n审查数据库迁移与回滚风险。\n## Workflow\n检查迁移顺序、事务边界和回滚路径。\n## Deliverables\n按严重程度报告具体文件和行号。\n## Boundaries\n不得修改项目文件，无法验证的风险需注明。",
    });
    expect(custom).toMatchObject({ permission: "readOnly", tools: ["Read", "Grep"] });
    await expect(registry.createGenerated("empty", {
      description: "Too short", permission: "readOnly", tools: ["Read"],
      maxIterations: 30, instructions: "Short",
    })).rejects.toThrow();
  });

  it("discovers global and project agents and gives project definitions precedence", async () => {
    const root = await mkdtemp(join(tmpdir(), "flavor-expert-agents-")); roots.push(root);
    const home = join(root, "home");
    const workspace = join(root, "project");
    const global = join(home, ".flavor-code", "agents");
    const project = join(workspace, ".flavor", "agents");
    await mkdir(global, { recursive: true });
    await mkdir(project, { recursive: true });
    await writeFile(join(global, "reviewer.md"), [
      "---", "name: reviewer", "description: Global review", "permission: readOnly", "---", "Review globally.",
    ].join("\n"));
    await writeFile(join(project, "reviewer.md"), [
      "---", "name: reviewer", "description: Project review", "model: fake:review",
      "tools: [Read, Grep]", "permission: readOnly", "maxIterations: 30", "---", "Review this project.",
    ].join("\n"));
    const registry = new ExpertAgentRegistry(home, workspace);
    expect(await registry.discover()).toEqual([expect.objectContaining({
      name: "reviewer", source: "project", description: "Project review", model: "fake:review",
      tools: ["Read", "Grep"], permission: "readOnly", maxIterations: 30,
    })]);
    expect((await registry.get("reviewer")).instructions).toBe("Review this project.");
  });

  it("rejects malformed definitions and reports the relevant error on explicit lookup", async () => {
    const root = await mkdtemp(join(tmpdir(), "flavor-expert-invalid-")); roots.push(root);
    const project = join(root, ".flavor", "agents");
    await mkdir(project, { recursive: true });
    await writeFile(join(project, "reviewer.md"), "---\nname: different\ndescription: Review\n---\nInspect code.\n");
    const registry = new ExpertAgentRegistry(root, root);
    expect(await registry.discover()).toEqual([]);
    await expect(registry.get("reviewer")).rejects.toThrow("filename must match");
    expect(registry.diagnostics).toEqual([expect.objectContaining({ path: join(project, "reviewer.md") })]);
  });
});
