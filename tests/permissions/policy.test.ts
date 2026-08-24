import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { PermissionEngine } from "../../src/permissions/engine.js";
import { loadPermissionPolicy } from "../../src/permissions/policy.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function fixture(): Promise<{ workspace: string; home: string }> {
  const workspace = await mkdtemp(join(tmpdir(), "flavor-policy-workspace-"));
  const home = await mkdtemp(join(tmpdir(), "flavor-policy-home-"));
  roots.push(workspace, home);
  await mkdir(join(workspace, ".flavor"), { recursive: true });
  return { workspace, home };
}

describe("permission policy", () => {
  it("uses the strictest matching rule and can authorize a built-in ask", async () => {
    const { workspace, home } = await fixture();
    await writeFile(join(workspace, ".flavor", "permissions.json"), JSON.stringify({
      version: 1,
      rules: [
        { id: "allow-tests", decision: "allow", prefix: ["npm", "test"], match: [["npm", "test"]], notMatch: [["npm", "run", "build"]] },
        { id: "deny-remote", decision: "deny", prefix: ["npm", "test", "--", "remote"] },
      ],
    }), "utf8");
    const policy = await loadPermissionPolicy({ workspace, home });
    const engine = new PermissionEngine({ workspace, mode: "default", policy });

    expect(engine.decide({ agent: "main", tool: "Shell", command: "npm", args: ["test"], cwd: workspace }).decision).toBe("allow");
    expect(engine.decide({ agent: "main", tool: "Shell", command: "npm", args: ["test", "--", "remote"], cwd: workspace }).decision).toBe("deny");
  });

  it("never lets an allow rule weaken a built-in safety denial", async () => {
    const { workspace, home } = await fixture();
    await writeFile(join(workspace, ".flavor", "permissions.json"), JSON.stringify({
      version: 1,
      rules: [{ id: "unsafe", decision: "allow", prefix: ["rm", "-rf", "/"] }],
    }), "utf8");
    const policy = await loadPermissionPolicy({ workspace, home });
    expect(new PermissionEngine({ workspace, mode: "bypassPermissions", policy }).decide({
      agent: "main", tool: "Shell", command: "rm", args: ["-rf", "/"], cwd: workspace,
    }).decision).toBe("deny");
  });

  it("fails policy loading when executable examples contradict the rule", async () => {
    const { workspace, home } = await fixture();
    await writeFile(join(workspace, ".flavor", "permissions.json"), JSON.stringify({
      version: 1,
      rules: [{ id: "broken", decision: "allow", prefix: ["npm", "test"], match: [["npm", "run", "build"]] }],
    }), "utf8");
    await expect(loadPermissionPolicy({ workspace, home })).rejects.toThrow(/match example/i);
  });
});
