import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { loadConfig } from "../../src/config/load.js";
import { SkillManager } from "../../src/skills/manager.js";
import { SkillRegistry } from "../../src/skills/registry.js";

describe("SkillManager", () => {
  it("creates, reads, updates, toggles and deletes project skills", async () => {
    const root = await mkdtemp(join(tmpdir(), "flavor-skill-manager-"));
    const workspace = join(root, "workspace");
    const home = join(root, "home");
    await mkdir(workspace, { recursive: true });
    const manager = new SkillManager({ workspace, home });

    const created = await manager.create({
      name: "release-check",
      description: "Verify a release before publishing",
      body: "# Release check\n\nRun the tests and inspect the package.",
    });
    expect(created).toMatchObject({ name: "release-check", source: "project", enabled: true, editable: true });
    expect((await manager.get("release-check")).body).toContain("Run the tests");

    const updated = await manager.update("release-check", {
      name: "release-check",
      description: "Verify release artifacts",
      body: "# Updated\n\nInspect every artifact.",
      disableModelInvocation: true,
    });
    expect(updated).toMatchObject({ description: "Verify release artifacts", disableModelInvocation: true });

    await manager.setEnabled("release-check", false);
    expect(await manager.list()).toContainEqual(expect.objectContaining({ name: "release-check", enabled: false }));
    expect((await loadConfig({ cwd: workspace, home })).config.skills.disabled).toEqual(["release-check"]);

    const registry = new SkillRegistry({
      projectRoots: [join(workspace, ".flavor", "skills")],
    });
    const discovered = (await registry.discover())[0]!;
    registry.setDisabledNames(["release-check"]);
    expect(await registry.discover()).toEqual([]);
    expect(await registry.match("verify release artifacts")).toBeUndefined();
    await expect(registry.loadBody(discovered)).rejects.toThrow(/disabled/i);

    await manager.delete("release-check");
    expect(await manager.list()).toEqual([]);
    expect((await loadConfig({ cwd: workspace, home })).config.skills.disabled).toEqual([]);
  });

  it("lists global skills as read-only while allowing a project-level toggle", async () => {
    const root = await mkdtemp(join(tmpdir(), "flavor-global-skill-"));
    const workspace = join(root, "workspace");
    const home = join(root, "home");
    const directory = join(home, ".flavor-code", "skills", "global-guide");
    await mkdir(directory, { recursive: true });
    await mkdir(workspace, { recursive: true });
    await writeFile(join(directory, "SKILL.md"), "---\nname: global-guide\ndescription: Shared guidance\n---\n\nUse shared guidance.\n");
    const manager = new SkillManager({ workspace, home });

    expect(await manager.list()).toContainEqual(expect.objectContaining({
      name: "global-guide", source: "global", editable: false, enabled: true,
    }));
    await manager.setEnabled("global-guide", false);
    expect(JSON.parse(await readFile(join(workspace, ".flavor", "flavor.json"), "utf8"))).toMatchObject({
      skills: { disabled: ["global-guide"] },
    });
  });

  it("includes declared plugin skill roots as read-only skills", async () => {
    const root = await mkdtemp(join(tmpdir(), "flavor-plugin-skills-"));
    const workspace = join(root, "workspace");
    const home = join(root, "home");
    const plugin = join(workspace, ".flavor", "plugins", "review-pack");
    const skill = join(plugin, "skills", "review-guide");
    await mkdir(skill, { recursive: true });
    await writeFile(join(plugin, "index.js"), "export function activate() {}\n");
    await writeFile(join(plugin, "flavor-plugin.json"), JSON.stringify({
      name: "review-pack", version: "1.0.0", apiVersion: "1", main: "./index.js", permissions: [],
      contributes: { commands: [], tools: [], hooks: [], skillRoots: [{ name: "review", path: "./skills" }], modelAdapters: [] },
    }));
    await writeFile(join(skill, "SKILL.md"), "---\nname: review-guide\ndescription: Review guidance\n---\n\nReview carefully.\n");

    expect(await new SkillManager({ workspace, home }).list()).toContainEqual(expect.objectContaining({
      name: "review-guide", source: "project", editable: false,
    }));
  });
});
