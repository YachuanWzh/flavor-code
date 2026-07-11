import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { SkillRegistry } from "../../src/skills/registry.js";

async function skill(root: string, folder: string, frontmatter: string, body = "Instructions") {
  const directory = join(root, folder);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "SKILL.md"), `---\n${frontmatter}\n---\n${body}`);
  return directory;
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "flavor-skills-"));
  const globalRoot = join(root, "global");
  const projectRoot = join(root, "project");
  await mkdir(globalRoot); await mkdir(projectRoot);
  return { root, globalRoot, projectRoot };
}

describe("SkillRegistry", () => {
  it("discovers strict metadata and lets project skills override global skills", async () => {
    const f = await fixture();
    await skill(f.globalRoot, "code-review", "name: code-review\ndescription: Review code carefully", "GLOBAL BODY");
    await skill(f.projectRoot, "code-review", "name: code-review\ndescription: Project review rules", "PROJECT BODY");
    await skill(f.globalRoot, "Bad_Name", "name: Bad_Name\ndescription: invalid name");
    await skill(f.projectRoot, "extra-key", "name: extra-key\ndescription: invalid metadata\nauthor: nobody");
    await skill(f.projectRoot, "broken-yaml", "name: [broken\ndescription: nope");

    const registry = new SkillRegistry({ globalRoots: [f.globalRoot], projectRoots: [f.projectRoot] });
    const discovered = await registry.discover();

    expect(discovered).toEqual([
      expect.objectContaining({ name: "code-review", description: "Project review rules", source: "project" }),
    ]);
    expect(discovered[0]).not.toHaveProperty("body");
    expect(registry.diagnostics).toHaveLength(3);
  });

  it("loads a body lazily only when explicitly requested after deterministic matching", async () => {
    const f = await fixture();
    const directory = await skill(f.globalRoot, "testing", "name: testing\ndescription: Run focused unit tests", "SECRET BODY");
    const registry = new SkillRegistry({ globalRoots: [f.globalRoot] });
    await registry.discover();

    expect(JSON.stringify(await registry.discover())).not.toContain("SECRET BODY");
    const matched = await registry.match("please run unit tests");
    expect(matched?.name).toBe("testing");
    expect(await registry.loadBody(matched!)).toBe("SECRET BODY");

    await writeFile(join(directory, "SKILL.md"), "removed after discovery");
    await expect(registry.loadBody(matched!)).rejects.toThrow(/frontmatter|changed/i);
  });

  it("uses stable lexical tie-breaking and permits an injected selector to refine matches", async () => {
    const f = await fixture();
    await skill(f.globalRoot, "alpha-test", "name: alpha-test\ndescription: Test code");
    await skill(f.globalRoot, "beta-test", "name: beta-test\ndescription: Test code");
    const deterministic = new SkillRegistry({ globalRoots: [f.globalRoot] });
    expect((await deterministic.match("test code"))?.name).toBe("alpha-test");
    const selector = vi.fn(async () => "beta-test");
    const registry = new SkillRegistry({ globalRoots: [f.globalRoot], selector });

    expect((await registry.match("test code"))?.name).toBe("beta-test");
    expect(selector).toHaveBeenCalledWith("test code", expect.arrayContaining([
      expect.objectContaining({ name: "alpha-test" }), expect.objectContaining({ name: "beta-test" }),
    ]));
  });

  it("rejects duplicate project names across roots without shadowing global metadata", async () => {
    const f = await fixture();
    const secondProjectRoot = join(f.root, "project-two"); await mkdir(secondProjectRoot);
    await skill(f.globalRoot, "testing", "name: testing\ndescription: Global testing");
    await skill(f.projectRoot, "testing", "name: testing\ndescription: Project one");
    await skill(secondProjectRoot, "testing", "name: testing\ndescription: Project two");
    const registry = new SkillRegistry({
      globalRoots: [f.globalRoot], projectRoots: [f.projectRoot, secondProjectRoot],
    });

    expect(await registry.discover()).toEqual([
      expect.objectContaining({ name: "testing", description: "Global testing", source: "global" }),
    ]);
    expect(registry.diagnostics.some((item) => /duplicate/i.test(item.message))).toBe(true);
  });

  it("rejects traversal, symlink escapes, unreferenced resources, and denied access", async () => {
    const f = await fixture();
    const directory = await skill(
      f.projectRoot, "deploy", "name: deploy\ndescription: Deploy an app",
      "Read [the checklist](references/checklist.md); never follow assets/outside.md.",
    );
    await mkdir(join(directory, "references"));
    await writeFile(join(directory, "references", "checklist.md"), "safe");
    await writeFile(join(directory, "references", "unmentioned.md"), "not directly referenced");
    const outsideResources = join(f.root, "outside-resources"); await mkdir(outsideResources);
    await writeFile(join(outsideResources, "outside.md"), "outside");
    await symlink(outsideResources, join(directory, "assets"), process.platform === "win32" ? "junction" : "dir");
    const authorizeResource = vi.fn(async (path: string) => !path.endsWith("checklist.md"));
    const registry = new SkillRegistry({ projectRoots: [f.projectRoot], authorizeResource });
    const matched = (await registry.match("deploy app"))!;

    await expect(registry.resolveResource(matched, "../outside.md")).rejects.toThrow(/escape|traversal/i);
    await expect(registry.resolveResource(matched, "assets/outside.md")).rejects.toThrow(/symlink|escape/i);
    await expect(registry.resolveResource(matched, "references/unmentioned.md")).rejects.toThrow(/referenced/i);
    await expect(registry.readResource(matched, "references/checklist.md")).rejects.toThrow(/permission/i);
    expect(authorizeResource).toHaveBeenCalledWith(join(directory, "references", "checklist.md"), matched);
  });

  it("enforces metadata, body, and resource size limits without executing scripts", async () => {
    const f = await fixture();
    await skill(f.globalRoot, "huge-meta", `name: huge-meta\ndescription: ${"x".repeat(200)}`);
    const directory = await skill(
      f.globalRoot, "bounded", "name: bounded\ndescription: Bounded data",
      "Use scripts/run.js and references/data.txt.",
    );
    await skill(f.globalRoot, "huge-body", "name: huge-body\ndescription: Huge body", "b".repeat(100));
    await mkdir(join(directory, "scripts")); await mkdir(join(directory, "references"));
    await writeFile(join(directory, "scripts", "run.js"), "throw new Error('must not execute')");
    await writeFile(join(directory, "references", "data.txt"), "r".repeat(100));
    const registry = new SkillRegistry({
      globalRoots: [f.globalRoot], maxMetadataBytes: 128, maxBodyBytes: 64, maxResourceBytes: 64,
      authorizeResource: () => true,
    });
    const discovered = await registry.discover();
    expect(discovered.map(({ name }) => name)).toEqual(["bounded", "huge-body"]);
    const matched = (await registry.match("bounded data"))!;
    const hugeBody = (await registry.match("huge body"))!;
    await expect(registry.loadBody(hugeBody)).rejects.toThrow(/body.*large/i);
    await expect(registry.readResource(matched, "references/data.txt")).rejects.toThrow(/resource.*large/i);
    expect(await registry.readResource(matched, "scripts/run.js")).toContain("must not execute");
  });

  it("rejects skill directories and SKILL files that are symlinks", async () => {
    const f = await fixture();
    const outside = join(f.root, "outside-skill");
    await skill(f.root, "outside-skill", "name: linked\ndescription: linked");
    await symlink(outside, join(f.globalRoot, "linked"), process.platform === "win32" ? "junction" : "dir");
    const normal = join(f.globalRoot, "linked-file"); await mkdir(normal);
    try {
      await symlink(join(outside, "SKILL.md"), join(normal, "SKILL.md"), "file");
    } catch (error) {
      if (!(process.platform === "win32" && error instanceof Error && "code" in error && error.code === "EPERM")) throw error;
    }
    const registry = new SkillRegistry({ globalRoots: [f.globalRoot] });
    expect(await registry.discover()).toEqual([]);
    expect(registry.diagnostics).toHaveLength(2);
  });
});
