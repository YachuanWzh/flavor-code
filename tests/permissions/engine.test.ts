import { mkdirSync, mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { describe, expect, it } from "vitest";

import { PermissionEngine } from "../../src/permissions/engine.js";

describe("PermissionEngine", () => {
  it("never permits a subagent write outside the workspace", () => {
    const workspace = mkdtempSync(join(tmpdir(), "flavor-workspace-"));
    const outside = mkdtempSync(join(tmpdir(), "flavor-outside-"));
    const engine = new PermissionEngine({ workspace, mode: "full" });
    expect(engine.decide({ agent: "subagent", tool: "Write", paths: [join(outside, "file")] }).decision).toBe("deny");
  });

  it("implements safe, workspace, and full file decisions", () => {
    const workspace = mkdtempSync(join(tmpdir(), "flavor-workspace-"));
    const outside = mkdtempSync(join(tmpdir(), "flavor-outside-"));
    expect(new PermissionEngine({ workspace, mode: "safe" }).decide({ agent: "main", tool: "Read", paths: [join(outside, "x")] }).decision).toBe("allow");
    expect(new PermissionEngine({ workspace, mode: "safe" }).decide({ agent: "main", tool: "Write", paths: [join(workspace, "x")] }).decision).toBe("ask");
    expect(new PermissionEngine({ workspace, mode: "workspace" }).decide({ agent: "main", tool: "Write", paths: [join(workspace, "x")] }).decision).toBe("allow");
    expect(new PermissionEngine({ workspace, mode: "workspace" }).decide({ agent: "main", tool: "Write", paths: [join(outside, "x")] }).decision).toBe("ask");
    expect(new PermissionEngine({ workspace, mode: "full" }).decide({ agent: "main", tool: "Write", paths: [join(outside, "x")] }).decision).toBe("allow");
  });

  it("denies lexical traversal and symlink escape", () => {
    const root = mkdtempSync(join(tmpdir(), "flavor-workspace-"));
    const workspace = join(root, "workspace");
    const outside = join(root, "outside");
    mkdirSync(workspace); mkdirSync(outside);
    const engine = new PermissionEngine({ workspace, mode: "workspace" });
    expect(engine.decide({ agent: "main", tool: "Write", paths: [`${workspace}${sep}..${sep}outside${sep}x`] }).decision).toBe("deny");
    if (process.platform === "win32") {
      const forwardSlashTraversal = `${workspace.replaceAll("\\", "/")}/../outside/x`;
      expect(engine.decide({ agent: "main", tool: "Write", paths: [forwardSlashTraversal] }).decision).toBe("deny");
    }
    const link = join(workspace, "link");
    symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir");
    expect(engine.decide({ agent: "main", tool: "Write", paths: [join(link, "x")] }).decision).toBe("deny");
  });

  it("classifies routine, network, and forbidden shell commands", () => {
    const workspace = mkdtempSync(join(tmpdir(), "flavor-workspace-"));
    const engine = new PermissionEngine({ workspace, mode: "workspace" });
    expect(engine.decide({ agent: "main", tool: "Shell", command: "npm test" }).decision).toBe("allow");
    expect(engine.decide({ agent: "main", tool: "Shell", command: "npm run build" }).decision).toBe("allow");
    expect(engine.decide({ agent: "main", tool: "Shell", command: "curl https://example.com" }).decision).toBe("ask");
    expect(engine.decide({ agent: "main", tool: "Shell", command: "rm -rf /" }).decision).toBe("ask");
    expect(new PermissionEngine({ workspace, mode: "full" }).decide({ agent: "main", tool: "Shell", command: "rm -rf /" }).decision).toBe("deny");
  });

  it("relays subagent approval requests as ask", () => {
    const workspace = mkdtempSync(join(tmpdir(), "flavor-workspace-"));
    const engine = new PermissionEngine({ workspace, mode: "safe" });
    expect(engine.decide({ agent: "subagent", tool: "Write", paths: [join(workspace, "x")] }).decision).toBe("ask");
  });

  it("applies subagent restrictions before full-mode shortcuts", () => {
    const workspace = mkdtempSync(join(tmpdir(), "flavor-workspace-"));
    const outside = mkdtempSync(join(tmpdir(), "flavor-outside-"));
    const engine = new PermissionEngine({ workspace, mode: "full" });
    expect(engine.decide({ agent: "subagent", tool: "WebFetch" }).decision).toBe("ask");
    expect(engine.decide({ agent: "subagent", tool: "Shell", command: "npm test", cwd: workspace }).decision).toBe("allow");
    expect(engine.decide({ agent: "subagent", tool: "Shell", command: "npm test" }).decision).toBe("ask");
    expect(engine.decide({ agent: "subagent", tool: "Shell", command: "curl https://example.com", cwd: workspace }).decision).toBe("ask");
    expect(engine.decide({ agent: "subagent", tool: "Shell", command: "sh -c 'npm test'", cwd: workspace }).decision).toBe("ask");
    expect(engine.decide({ agent: "subagent", tool: "Shell", command: "rm -r -f /", cwd: workspace }).decision).toBe("deny");
    expect(engine.decide({ agent: "subagent", tool: "Shell", command: "npm test", cwd: outside }).decision).toBe("deny");
  });

  it("detects destructive and opaque commands behind wrappers", () => {
    const workspace = mkdtempSync(join(tmpdir(), "flavor-workspace-"));
    const engine = new PermissionEngine({ workspace, mode: "full" });
    for (const command of [
      "rm -r -f /",
      "rm --recursive --force /",
      "npm test && rm -r -f /",
      "cmd /c rm -r -f /",
      "sh -c 'rm -r -f /'",
      "bash -c 'rm -rf /'",
      "zsh -c 'rm -rf /'",
      "powershell -Command 'Remove-Item -Recurse C:\\'",
      "pwsh -Command 'Remove-Item -r C:\\'",
    ]) {
      expect(engine.decide({ agent: "main", tool: "Shell", command }).decision, command).toBe("deny");
    }
    expect(engine.decide({ agent: "main", tool: "Shell", command: "pwsh -File script.ps1" }).decision).toBe("ask");
  });

  it("does not authorize path-bearing tools without paths", () => {
    const workspace = mkdtempSync(join(tmpdir(), "flavor-workspace-"));
    const engine = new PermissionEngine({ workspace, mode: "full" });
    for (const tool of ["Read", "Write", "Edit", "ApplyPatch", "Glob", "Grep"]) {
      expect(engine.decide({ agent: "main", tool, paths: [] }), tool).toMatchObject({
        decision: "deny",
        reason: expect.stringContaining("path"),
      });
    }
  });

  it("defaults to workspace mode", () => {
    const workspace = mkdtempSync(join(tmpdir(), "flavor-workspace-"));
    const outside = mkdtempSync(join(tmpdir(), "flavor-outside-"));
    const engine = new PermissionEngine({ workspace });
    expect(engine.decide({ agent: "main", tool: "Write", paths: [join(workspace, "x")] }).decision).toBe("allow");
    expect(engine.decide({ agent: "main", tool: "Write", paths: [join(outside, "x")] }).decision).toBe("ask");
  });
});
