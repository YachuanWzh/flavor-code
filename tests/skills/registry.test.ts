import { mkdir, mkdtemp, open as fsOpen, rename, symlink, writeFile } from "node:fs/promises";
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
      "Read [the checklist](references/checklist.md); [outside](assets/outside.md) is unsafe.",
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
      "Use `scripts/run.js` and [data](references/data.txt).",
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
    expect((await registry.readResource(matched, "scripts/run.js")).toString("utf8")).toContain("must not execute");
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

  it("rejects duplicate keys, aliases, tags, multiple YAML documents, and invalid UTF-8 metadata", async () => {
    const f = await fixture();
    await skill(f.globalRoot, "duplicate-key", "name: duplicate-key\nname: duplicate-key\ndescription: duplicate");
    await skill(f.globalRoot, "alias-skill", "name: &skill alias-skill\ndescription: *skill");
    await skill(f.globalRoot, "multi-doc", "name: multi-doc\ndescription: first\n...\nname: second");
    await skill(f.globalRoot, "tagged", "name: tagged\ndescription: !untrusted tagged");
    const invalid = join(f.globalRoot, "invalid-utf8"); await mkdir(invalid);
    await writeFile(join(invalid, "SKILL.md"), Buffer.concat([
      Buffer.from("---\nname: invalid-utf8\ndescription: "), Buffer.from([0xff]), Buffer.from("\n---\nbody"),
    ]));

    const registry = new SkillRegistry({ globalRoots: [f.globalRoot] });
    expect(await registry.discover()).toEqual([]);
    expect(registry.diagnostics).toHaveLength(5);
  });

  it("decodes SKILL.md bodies with fatal UTF-8", async () => {
    const f = await fixture();
    const directory = await skill(f.globalRoot, "invalid-body", "name: invalid-body\ndescription: Invalid body", "");
    await writeFile(join(directory, "SKILL.md"), Buffer.concat([
      Buffer.from("---\nname: invalid-body\ndescription: Invalid body\n---\n"), Buffer.from([0xff]),
    ]));
    const registry = new SkillRegistry({ globalRoots: [f.globalRoot] });
    const matched = (await registry.match("invalid body"))!;
    await expect(registry.loadBody(matched)).rejects.toThrow(/utf-?8|encoding/i);
  });

  it("extracts only Markdown destinations and inline-code resource references", async () => {
    const f = await fixture();
    const directory = await skill(
      f.globalRoot, "references", "name: references\ndescription: Explicit references",
      "xassets/prefix.bin https://host/assets/url.bin never use assets/negative.bin "
        + "[real](assets/real.bin) and `scripts/run.js`.",
    );
    await mkdir(join(directory, "assets")); await mkdir(join(directory, "scripts"));
    for (const file of ["prefix.bin", "url.bin", "negative.bin", "real.bin"]) {
      await writeFile(join(directory, "assets", file), file);
    }
    await writeFile(join(directory, "scripts", "run.js"), "code");
    const registry = new SkillRegistry({ globalRoots: [f.globalRoot], authorizeResource: () => true });
    const matched = (await registry.match("explicit references"))!;

    await expect(registry.resolveResource(matched, "assets/prefix.bin")).rejects.toThrow(/referenced/i);
    await expect(registry.resolveResource(matched, "assets/url.bin")).rejects.toThrow(/referenced/i);
    await expect(registry.resolveResource(matched, "assets/negative.bin")).rejects.toThrow(/referenced/i);
    await expect(registry.resolveResource(matched, "assets/real.bin")).resolves.toMatchObject({
      path: join(directory, "assets", "real.bin"), reference: "assets/real.bin", size: 8,
    });
    await expect(registry.resolveResource(matched, "scripts/run.js")).resolves.toMatchObject({ reference: "scripts/run.js" });
  });

  it("preserves binary resources and fatally decodes explicit text reads", async () => {
    const f = await fixture();
    const directory = await skill(
      f.globalRoot, "binary", "name: binary\ndescription: Binary assets",
      "[blob](assets/blob.bin) and [text](references/invalid.txt)",
    );
    await mkdir(join(directory, "assets")); await mkdir(join(directory, "references"));
    const binary = Buffer.from([0x00, 0xff, 0x01]);
    await writeFile(join(directory, "assets", "blob.bin"), binary);
    await writeFile(join(directory, "references", "invalid.txt"), Buffer.from([0xff]));
    const registry = new SkillRegistry({ globalRoots: [f.globalRoot], authorizeResource: () => true });
    const matched = (await registry.match("binary assets"))!;

    expect(await registry.readResource(matched, "assets/blob.bin")).toEqual(binary);
    await expect(registry.readTextResource(matched, "references/invalid.txt")).rejects.toThrow(/utf-?8|encoding/i);
  });

  it("pins SKILL.md reads to the verified handle and rejects opened-file identity mismatches", async () => {
    const f = await fixture();
    const directory = await skill(f.globalRoot, "pinned", "name: pinned\ndescription: Pinned body", "ORIGINAL");
    let opens = 0;
    const registry = new SkillRegistry({
      globalRoots: [f.globalRoot],
      openFile: async (path, flags) => {
        opens += 1;
        if (opens !== 2) return fsOpen(path, flags);
        const handle = await fsOpen(path, flags);
        await rename(path, `${path}.old`);
        await writeFile(path, "---\nname: pinned\ndescription: Pinned body\n---\nREPLACEMENT");
        return handle;
      },
    });
    const matched = (await registry.match("pinned body"))!;
    expect(await registry.loadBody(matched)).toBe("ORIGINAL");
    expect(opens).toBe(2);

    let mismatchOpens = 0;
    const mismatch = new SkillRegistry({
      globalRoots: [f.globalRoot],
      openFile: async (path, flags) => {
        mismatchOpens += 1;
        if (mismatchOpens !== 2) return fsOpen(path, flags);
        await rename(path, `${path}.replacement-old`);
        await writeFile(path, "---\nname: pinned\ndescription: Pinned body\n---\nDIFFERENT");
        return fsOpen(path, flags);
      },
    });
    const mismatched = (await mismatch.match("pinned body"))!;
    await expect(mismatch.loadBody(mismatched)).rejects.toThrow(/changed|identity|mismatch/i);
  });

  it("enforces resource bounds during resolution and detects replacement before reading", async () => {
    const f = await fixture();
    const directory = await skill(
      f.globalRoot, "resource-race", "name: resource-race\ndescription: Resource race",
      "[large](assets/large.bin) and [race](assets/race.bin)",
    );
    await mkdir(join(directory, "assets"));
    await writeFile(join(directory, "assets", "large.bin"), Buffer.alloc(5));
    await writeFile(join(directory, "assets", "race.bin"), Buffer.from("OLD"));
    let resourceOpens = 0;
    const registry = new SkillRegistry({
      globalRoots: [f.globalRoot], maxResourceBytes: 4, authorizeResource: () => true,
      openFile: async (path, flags) => {
        const handle = await fsOpen(path, flags);
        if (path.endsWith("race.bin") && ++resourceOpens === 1) {
          await rename(path, `${path}.old`);
          await writeFile(path, "NEW");
        }
        return handle;
      },
    });
    const matched = (await registry.match("resource race"))!;

    await expect(registry.resolveResource(matched, "assets/large.bin")).rejects.toThrow(/resource.*large/i);
    await expect(registry.readResource(matched, "assets/race.bin")).rejects.toThrow(/changed|identity|mismatch/i);
  });

  it("does not depend on locale collation for discovery or matching", async () => {
    const f = await fixture();
    await skill(f.globalRoot, "alpha", "name: alpha\ndescription: Tie");
    await skill(f.globalRoot, "beta", "name: beta\ndescription: Tie");
    const original = String.prototype.localeCompare;
    String.prototype.localeCompare = () => { throw new Error("locale collation used"); };
    try {
      const registry = new SkillRegistry({ globalRoots: [f.globalRoot] });
      expect((await registry.match("tie"))?.name).toBe("alpha");
    } finally {
      String.prototype.localeCompare = original;
    }
  });
});
