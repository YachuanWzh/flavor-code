import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { D2C_SKILL_NAME, d2cSkillContent, ensureD2cSkill } from "../../src/d2c/skill-template.js";
import { SkillRegistry } from "../../src/skills/registry.js";

const directories: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "flavor-d2c-skill-"));
  directories.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("d2cSkillContent", () => {
  it("opens with YAML frontmatter naming the skill", () => {
    const content = d2cSkillContent();
    expect(content.startsWith("---\n")).toBe(true);
    expect(content).toContain(`name: ${D2C_SKILL_NAME}`);
    expect(content).toMatch(/description: .+/);
  });

  it("guides the agent through import, generation and comparison", () => {
    const content = d2cSkillContent();
    expect(content).toContain("D2cImport");
    expect(content).toContain("D2cCompare");
    expect(content).toMatch(/Vue/i);
  });
});

describe("ensureD2cSkill", () => {
  it("installs the skill into .flavor/skills", async () => {
    const workspace = await tempDir();
    const result = await ensureD2cSkill(workspace);
    expect(result.installed).toBe(true);
    expect(result.path).toBe(join(workspace, ".flavor", "skills", D2C_SKILL_NAME, "SKILL.md"));
    const content = await readFile(result.path, "utf8");
    expect(content).toBe(d2cSkillContent());
  });

  it("is idempotent when the content is unchanged", async () => {
    const workspace = await tempDir();
    await ensureD2cSkill(workspace);
    const second = await ensureD2cSkill(workspace);
    expect(second.installed).toBe(false);
  });

  it("overwrites a stale copy", async () => {
    const workspace = await tempDir();
    const skillFile = join(workspace, ".flavor", "skills", D2C_SKILL_NAME, "SKILL.md");
    await mkdir(join(skillFile, ".."), { recursive: true });
    await writeFile(skillFile, "---\nname: d2c-pixso\ndescription: old\n---\noutdated body\n");
    const result = await ensureD2cSkill(workspace);
    expect(result.installed).toBe(true);
    expect(await readFile(skillFile, "utf8")).toBe(d2cSkillContent());
  });

  it("produces a skill that the registry discovers", async () => {
    const workspace = await tempDir();
    await ensureD2cSkill(workspace);
    const registry = new SkillRegistry({ projectRoots: [join(workspace, ".flavor", "skills")] });
    const skills = await registry.discover();
    expect(skills.map((skill) => skill.name)).toContain(D2C_SKILL_NAME);
    expect(registry.diagnostics).toEqual([]);
  });
});
