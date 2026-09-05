import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createGitHistoryTool } from "../../src/git/tools.js";
import { git } from "../../src/git/service.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
describe("GitHistory", () => {
  it("handles unborn repositories, literal filenames, and workspace paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "flavor git tools ")); roots.push(root);
    expect((await git(root, ["init"])).ok).toBe(true);
    const tool = createGitHistoryTool(root);
    const signal = new AbortController().signal;
    expect(await tool.execute({}, signal)).toBe("No commits found.");
    const path = join(root, "[notes].txt");
    await writeFile(path, "hello");
    expect((await git(root, ["add", "--", "[notes].txt"])).ok).toBe(true);
    expect((await git(root, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "literal path"])).ok).toBe(true);
    expect(await tool.execute({ path }, signal)).toContain("literal path");
    expect(tool.paths({ path: "[notes].txt" })).toEqual([path]);
    await expect(tool.execute({ path: "../outside" }, signal)).rejects.toThrow(/outside/);
  });
});
