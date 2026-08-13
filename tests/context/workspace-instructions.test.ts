import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { WorkspaceInstructions } from "../../src/context/workspace-instructions.js";

describe("WorkspaceInstructions", () => {
  it("loads root and nested instructions in deterministic root-to-leaf order", async () => {
    const root = await mkdtemp(join(tmpdir(), "flavor-instructions-"));
    await mkdir(join(root, "src", "feature"), { recursive: true });
    await writeFile(join(root, "AGENTS.md"), "root agents");
    await writeFile(join(root, "CLAUDE.md"), "root claude");
    await writeFile(join(root, "src", "AGENTS.md"), "src agents");
    await writeFile(join(root, "src", "feature", "AGENTS.local.md"), "feature local");
    const instructions = new WorkspaceInstructions(root);

    const baseline = await instructions.baseline();
    const nested = await instructions.discover([join(root, "src", "feature", "index.ts")]);

    expect(baseline).toContain("root agents");
    expect(baseline).toContain("root claude");
    expect(nested.join("\n")).toMatch(/src agents[\s\S]*feature local/);
    expect(await instructions.discover([join(root, "src", "feature", "other.ts")])).toEqual([]);
  });

  it("emits changed instruction files again", async () => {
    const root = await mkdtemp(join(tmpdir(), "flavor-instructions-"));
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src", "AGENTS.md"), "one");
    const instructions = new WorkspaceInstructions(root);
    expect((await instructions.discover([join(root, "src", "a.ts")])).join("\n")).toContain("one");
    await writeFile(join(root, "src", "AGENTS.md"), "two");
    expect((await instructions.discover([join(root, "src", "b.ts")])).join("\n")).toContain("two");
  });

  it.skipIf(process.platform === "win32")("rejects instruction symlinks that escape the workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "flavor-instructions-"));
    const outside = await mkdtemp(join(tmpdir(), "flavor-instructions-outside-"));
    await writeFile(join(outside, "AGENTS.md"), "outside secret");
    await symlink(join(outside, "AGENTS.md"), join(root, "AGENTS.md"));
    expect(await new WorkspaceInstructions(root).baseline()).not.toContain("outside secret");
  });
});
