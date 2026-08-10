import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { readD2cModules } from "../../src/d2c/modules.js";

const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))));

describe("D2C module manifest", () => {
  it("loads valid modules and falls back for legacy projects", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "flavor-d2c-modules-")); dirs.push(workspace);
    const project = join(workspace, "src", "d2c-output", "dashboard");
    await mkdir(project, { recursive: true });
    await expect(readD2cModules(workspace, "dashboard")).resolves.toEqual([
      expect.objectContaining({ id: "page", label: "dashboard" }),
    ]);
    await writeFile(join(project, "d2c.modules.json"), JSON.stringify({ schema: 1, modules: [{
      id: "stats", label: "统计卡片", sourceFiles: ["src/components/Stats.vue"], keywords: ["metrics"],
    }] }));
    await expect(readD2cModules(workspace, "dashboard")).resolves.toEqual([
      { id: "stats", label: "统计卡片", sourceFiles: ["src/components/Stats.vue"], keywords: ["metrics"] },
    ]);
  });

  it("tolerates extra root metadata written by agents", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "flavor-d2c-modules-")); dirs.push(workspace);
    const project = join(workspace, "src", "d2c-output", "dashboard");
    await mkdir(project, { recursive: true });
    await writeFile(join(project, "d2c.modules.json"), JSON.stringify({ schema: 1, project: "dashboard", product: "控制台", modules: [{
      id: "stats", label: "统计卡片", sourceFiles: ["src/components/Stats.vue"],
    }] }));
    await expect(readD2cModules(workspace, "dashboard")).resolves.toEqual([
      { id: "stats", label: "统计卡片", sourceFiles: ["src/components/Stats.vue"] },
    ]);
  });

  it("rejects source paths that escape the generated project", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "flavor-d2c-modules-")); dirs.push(workspace);
    const project = join(workspace, "src", "d2c-output", "dashboard");
    await mkdir(project, { recursive: true });
    await writeFile(join(project, "d2c.modules.json"), JSON.stringify({ schema: 1, modules: [{ id: "x", label: "x", sourceFiles: ["../secret"] }] }));
    await expect(readD2cModules(workspace, "dashboard")).rejects.toThrow(/source|path/i);
    await writeFile(join(project, "d2c.modules.json"), JSON.stringify({ schema: 1, modules: [{ id: "x", label: "x", sourceFiles: ["..\\secret"] }] }));
    await expect(readD2cModules(workspace, "dashboard")).rejects.toThrow(/source|path/i);
    await writeFile(join(project, "d2c.modules.json"), JSON.stringify({ schema: 1, modules: [{ id: "x", label: "x", sourceFiles: ["C:\\secret"] }] }));
    await expect(readD2cModules(workspace, "dashboard")).rejects.toThrow(/source|path/i);
  });
});
