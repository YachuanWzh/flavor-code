import { mkdirSync, mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { describe, expect, it } from "vitest";

import { getToolCategory, PermissionEngine } from "../../src/permissions/engine.js";

describe("PermissionEngine", () => {
  it("implements the six canonical permission modes", () => {
    const workspace = mkdtempSync(join(tmpdir(), "flavor-canonical-permissions-"));
    const outside = mkdtempSync(join(tmpdir(), "flavor-canonical-outside-"));
    const localWrite = { agent: "main" as const, tool: "Write", paths: [join(workspace, "x")] };
    const outsideWrite = { agent: "main" as const, tool: "Write", paths: [join(outside, "x")] };
    const routine = { agent: "main" as const, tool: "Shell", command: "npm test", cwd: workspace };

    expect(new PermissionEngine({ workspace, mode: "default" }).decide(localWrite).decision).toBe("ask");
    expect(new PermissionEngine({ workspace, mode: "default" }).decide(routine).decision).toBe("ask");

    expect(new PermissionEngine({ workspace, mode: "acceptEdits" }).decide(localWrite).decision).toBe("allow");
    expect(new PermissionEngine({ workspace, mode: "acceptEdits" }).decide(outsideWrite).decision).toBe("ask");
    expect(new PermissionEngine({ workspace, mode: "acceptEdits" }).decide(routine).decision).toBe("allow");

    const plan = new PermissionEngine({ workspace, mode: "plan" });
    expect(plan.decide({ agent: "main", tool: "Read", paths: [join(workspace, "x")] }).decision).toBe("allow");
    expect(plan.decide(localWrite).decision).toBe("deny");
    expect(plan.decide(routine).decision).toBe("deny");
    expect(plan.decide({ agent: "main", tool: "WebFetch" }).decision).toBe("deny");

    const bypass = new PermissionEngine({ workspace, mode: "bypassPermissions" });
    expect(bypass.decide(outsideWrite).decision).toBe("allow");
    expect(bypass.decide({ agent: "main", tool: "Delete", paths: [join(workspace, "x")] }).decision).toBe("allow");
    expect(bypass.decide({ agent: "main", tool: "Shell", command: "rm -rf /" }).decision).toBe("deny");

    expect(new PermissionEngine({ workspace, mode: "auto" }).decide(localWrite).decision).toBe("allow");
    expect(new PermissionEngine({ workspace, mode: "auto" })
      .decide({ agent: "main", tool: "WebFetch" })).toMatchObject({
        decision: "ask", reason: expect.stringMatching(/classif/i),
      });

    const bubble = new PermissionEngine({ workspace, mode: "bubble" });
    expect(bubble.decide({ agent: "subagent", tool: "Read", paths: [join(workspace, "x")] }).decision).toBe("allow");
    expect(bubble.decide({ agent: "subagent", tool: "Write", paths: [join(workspace, "x")] }).decision).toBe("ask");
  });
  it("updates the main permission mode for subsequent decisions", () => {
    const engine = new PermissionEngine({ workspace: process.cwd(), mode: "safe" });
    const request = { agent: "main" as const, tool: "Shell", command: "npm", args: ["test"], cwd: process.cwd() };
    expect(engine.decide(request).decision).toBe("ask");
    engine.setMode("acceptEdits");
    expect(engine.mode).toBe("acceptEdits");
    expect(engine.decide(request).decision).toBe("allow");
  });

  it("auto-allows Electron D2C work except deletion while retaining workspace boundaries", () => {
    const workspace = mkdtempSync(join(tmpdir(), "flavor-d2c-permissions-"));
    const outside = mkdtempSync(join(tmpdir(), "flavor-d2c-outside-"));
    const engine = new PermissionEngine({ workspace, mode: "auto", profile: "d2c" });

    expect(engine.decide({ agent: "main", tool: "Write", paths: [join(workspace, "src", "App.tsx")] }).decision).toBe("allow");
    expect(engine.decide({ agent: "main", tool: "Move", paths: [join(workspace, "a"), join(workspace, "b")] }).decision).toBe("allow");
    expect(engine.decide({ agent: "main", tool: "Shell", command: "npm install", cwd: workspace }).decision).toBe("allow");
    expect(engine.decide({ agent: "main", tool: "Shell", command: "npm run build", cwd: workspace }).decision).toBe("allow");
    expect(engine.decide({ agent: "main", tool: "Shell", command: "npm test", cwd: workspace }).decision).toBe("allow");
    expect(engine.decide({ agent: "main", tool: "mcp__docs__search" }).decision).toBe("allow");
    expect(engine.decide({ agent: "main", tool: "mcp__github__delete_file" }).decision).toBe("ask");
    expect(engine.decide({ agent: "main", tool: "CustomD2cTool" }).decision).toBe("allow");

    expect(engine.decide({ agent: "main", tool: "Delete", paths: [join(workspace, "old.tsx")] })).toMatchObject({
      decision: "ask", reason: expect.stringMatching(/delet/i), allowAlways: false,
    });
    expect(engine.decide({ agent: "main", tool: "RemoveTool", paths: [join(workspace, ".flavor", "tools", "old.json")] }).decision).toBe("ask");
    for (const command of [
      "rm old.tsx",
      "rmdir generated",
      "del /q old.tsx",
      "powershell -Command 'Remove-Item old.tsx'",
      "git rm old.tsx",
      "git clean -fd",
      "npm test && rm old.tsx",
    ]) {
      expect(engine.decide({ agent: "main", tool: "Shell", command, cwd: workspace }).decision, command).toBe("ask");
    }

    expect(engine.decide({ agent: "main", tool: "Write", paths: [join(outside, "App.tsx")] }).decision).toBe("deny");
    expect(engine.decide({ agent: "main", tool: "Shell", command: "npm install", cwd: outside }).decision).toBe("deny");
    expect(engine.decide({ agent: "main", tool: "Shell", command: "rm -rf /", cwd: workspace }).decision).toBe("deny");
  });

  it("requires D2cCompare to own the preview-server lifecycle", () => {
    const workspace = mkdtempSync(join(tmpdir(), "flavor-d2c-preview-permissions-"));
    const engine = new PermissionEngine({ workspace, mode: "auto", profile: "d2c" });
    const commands = [
      { command: "cmd /c start /b npm run dev > vite.log 2>&1" },
      { command: "npm", args: ["run", "dev"] },
      { command: "npm.cmd", args: ["start"] },
      { command: "npx vite --host 127.0.0.1" },
      { command: "pnpm preview" },
      { command: "node node_modules/vite/bin/vite.js" },
    ];
    for (const command of commands) {
      expect(engine.decide({ agent: "main", tool: "Shell", cwd: workspace, ...command }), command.command).toMatchObject({
        decision: "deny",
        reason: expect.stringContaining("D2cCompare"),
      });
    }
  });

  it("switches the D2C profile without changing the configured permission mode", () => {
    const workspace = mkdtempSync(join(tmpdir(), "flavor-d2c-profile-"));
    const engine = new PermissionEngine({ workspace, mode: "default" });
    const write = { agent: "main" as const, tool: "Write", paths: [join(workspace, "App.tsx")] };

    expect(engine.decide(write).decision).toBe("ask");
    engine.setProfile("d2c");
    expect(engine.mode).toBe("default");
    expect(engine.profile).toBe("d2c");
    expect(engine.decide(write).decision).toBe("allow");
    engine.setProfile("standard");
    expect(engine.decide(write).decision).toBe("ask");
  });

  it("allows the internal Task tool only for the main agent", () => {
    const engine = new PermissionEngine({ workspace: process.cwd() });
    expect(engine.decide({ agent: "main", tool: "Task" }).decision).toBe("allow");
    expect(engine.decide({ agent: "subagent", tool: "Task" }).decision).toBe("deny");
  });

  it("always allows the internal TaskPlan and TaskUpdate tools", () => {
    const workspace = mkdtempSync(join(tmpdir(), "flavor-workspace-"));
    const outside = mkdtempSync(join(tmpdir(), "flavor-outside-"));
    for (const mode of ["safe", "workspace", "full"] as const) {
      for (const tool of ["TaskPlan", "TaskUpdate"]) {
        for (const agent of ["main", "subagent"] as const) {
          const engine = new PermissionEngine({ workspace, mode });
          expect(engine.decide({ agent, tool }).decision, `${mode} ${agent} ${tool}`).toBe("allow");
          // paths are irrelevant for control tools
          expect(engine.decide({ agent, tool, paths: [join(outside, "x")] }).decision, `${mode} ${agent} ${tool} with outside path`).toBe("allow");
        }
      }
    }
  });

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
    expect(new PermissionEngine({ workspace, mode: "workspace" }).decide({ agent: "main", tool: "Write", paths: [join(workspace, "x")] }).decision).toBe("ask");
    expect(new PermissionEngine({ workspace, mode: "workspace" }).decide({ agent: "main", tool: "Write", paths: [join(outside, "x")] }).decision).toBe("ask");
    expect(new PermissionEngine({ workspace, mode: "full" }).decide({ agent: "main", tool: "Write", paths: [join(outside, "x")] }).decision).toBe("allow");
  });

  it("denies lexical traversal and symlink escape", () => {
    const root = mkdtempSync(join(tmpdir(), "flavor-workspace-"));
    const workspace = join(root, "workspace");
    const outside = join(root, "outside");
    mkdirSync(workspace); mkdirSync(outside);
    const engine = new PermissionEngine({ workspace, mode: "default" });
    expect(engine.decide({ agent: "main", tool: "Write", paths: [`${workspace}${sep}..${sep}outside${sep}x`] }).decision).toBe("deny");
    if (process.platform === "win32") {
      const forwardSlashTraversal = `${workspace.replaceAll("\\", "/")}/../outside/x`;
      expect(engine.decide({ agent: "main", tool: "Write", paths: [forwardSlashTraversal] }).decision).toBe("deny");
    }
    const link = join(workspace, "link");
    symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir");
    expect(engine.decide({ agent: "main", tool: "Write", paths: [join(link, "x")] }).decision).toBe("deny");
  });

  it("classifies lexical paths correctly when the workspace sits behind a symlinked path component", () => {
    // CI runners expose temp dirs through aliased components (/var -> /private/var
    // on macOS, 8.3 short names on Windows); decisions must stay consistent when
    // the engine resolves the workspace physically but receives lexical paths.
    const root = mkdtempSync(join(tmpdir(), "flavor-aliased-permissions-"));
    const base = join(root, "base"); mkdirSync(base);
    const physicalWorkspace = join(base, "workspace"); mkdirSync(physicalWorkspace);
    symlinkSync(base, join(root, "alias"), process.platform === "win32" ? "junction" : "dir");
    const aliasedWorkspace = join(root, "alias", "workspace");
    const engine = new PermissionEngine({ workspace: aliasedWorkspace, mode: "acceptEdits" });

    expect(engine.decide({ agent: "main", tool: "Write", paths: [join(aliasedWorkspace, "x")] }).decision).toBe("allow");
    expect(engine.decide({ agent: "main", tool: "Write", paths: [`${aliasedWorkspace}${sep}..${sep}..${sep}x`] }).decision).toBe("deny");
    expect(engine.decide({ agent: "subagent", tool: "Write", paths: [join(aliasedWorkspace, "x")] }).decision).toBe("allow");
  });

  it("classifies routine, network, and forbidden shell commands", () => {
    const workspace = mkdtempSync(join(tmpdir(), "flavor-workspace-"));
    const engine = new PermissionEngine({ workspace, mode: "acceptEdits" });
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

  it("classifies namespaced MCP tools as network access", () => {
    const workspace = mkdtempSync(join(tmpdir(), "flavor-workspace-"));
    const tool = "mcp__docs__search";

    expect(getToolCategory(tool)).toBe("network");
    expect(new PermissionEngine({ workspace, mode: "workspace" })
      .decide({ agent: "main", tool }).decision).toBe("ask");
    expect(new PermissionEngine({ workspace, mode: "full" })
      .decide({ agent: "main", tool }).decision).toBe("allow");
    expect(new PermissionEngine({ workspace, mode: "full" })
      .decide({ agent: "subagent", tool }).decision).toBe("ask");
  });

  it("classifies managed-tool registration, removal, and listing by their durable effects", () => {
    const workspace = mkdtempSync(join(tmpdir(), "flavor-managed-permissions-"));
    const outside = mkdtempSync(join(tmpdir(), "flavor-managed-global-"));
    const projectPath = join(workspace, ".flavor", "tools", "echo.json");
    const globalPath = join(outside, ".flavor-code", "tools", "echo.json");

    expect(getToolCategory("RegisterTool")).toBe("write");
    expect(getToolCategory("RemoveTool")).toBe("destructive");
    expect(getToolCategory("ListRegisteredTools")).toBe("read");
    expect(new PermissionEngine({ workspace, mode: "default" })
      .decide({ agent: "main", tool: "RegisterTool", paths: [projectPath] }).decision).toBe("ask");
    expect(new PermissionEngine({ workspace, mode: "acceptEdits" })
      .decide({ agent: "main", tool: "RegisterTool", paths: [projectPath] }).decision).toBe("allow");
    expect(new PermissionEngine({ workspace, mode: "acceptEdits" })
      .decide({ agent: "main", tool: "RegisterTool", paths: [globalPath] }).decision).toBe("ask");
    expect(new PermissionEngine({ workspace, mode: "default" })
      .decide({ agent: "main", tool: "RemoveTool", paths: [projectPath] }).decision).toBe("ask");
    expect(new PermissionEngine({ workspace, mode: "bypassPermissions" })
      .decide({ agent: "main", tool: "RemoveTool", paths: [projectPath] }).decision).toBe("allow");
    expect(new PermissionEngine({ workspace, mode: "plan" })
      .decide({ agent: "main", tool: "ListRegisteredTools" }).decision).toBe("allow");
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
    for (const tool of ["Read", "Write", "Edit", "ApplyPatch", "Glob", "Grep", "Delete", "Move", "Copy", "Mkdir"]) {
      expect(engine.decide({ agent: "main", tool, paths: [] }), tool).toMatchObject({
        decision: "deny",
        reason: expect.stringContaining("path"),
      });
    }
    expect(engine.decide({ agent: "main", tool: "Move", paths: [join(workspace, "source")] }).decision).toBe("deny");
    expect(engine.decide({ agent: "main", tool: "Copy", paths: [join(workspace, "source")] }).decision).toBe("deny");
  });

  it("checks subagent routine-command path arguments against the workspace", () => {
    const root = mkdtempSync(join(tmpdir(), "flavor-command-paths-"));
    const workspace = join(root, "workspace");
    const outside = join(root, "outside");
    mkdirSync(workspace); mkdirSync(outside);
    const engine = new PermissionEngine({ workspace, mode: "full" });

    expect(engine.decide({ agent: "subagent", tool: "Shell", cwd: workspace, command: `pytest ${outside}` }).decision).toBe("deny");
    expect(engine.decide({ agent: "subagent", tool: "Shell", cwd: workspace, command: `npm test -- --config ${outside}` }).decision).toBe("deny");
    expect(engine.decide({ agent: "subagent", tool: "Shell", cwd: workspace, command: "npm test -- --config=../outside/config.ts" }).decision).toBe("deny");
    expect(engine.decide({ agent: "subagent", tool: "Shell", cwd: workspace, command: `pytest ${join(workspace, "tests")}` }).decision).toBe("allow");
    expect(engine.decide({ agent: "subagent", tool: "Shell", cwd: workspace, command: "pytest ambiguous-target" }).decision).toBe("ask");
    expect(engine.decide({ agent: "subagent", tool: "Shell", cwd: workspace, command: "make test" }).decision).toBe("ask");
  });

  it("checks main-agent routine-command cwd and path arguments before fast-path approval", () => {
    const root = mkdtempSync(join(tmpdir(), "flavor-main-command-paths-"));
    const workspace = join(root, "workspace");
    const outside = join(root, "outside");
    mkdirSync(workspace); mkdirSync(outside);
    for (const mode of ["acceptEdits", "auto"] as const) {
      const engine = new PermissionEngine({ workspace, mode });
      expect(engine.decide({ agent: "main", tool: "Shell", cwd: outside, command: "npm test" }).decision).toBe("deny");
      expect(engine.decide({ agent: "main", tool: "Shell", cwd: workspace, command: `npm test -- --config ${outside}` }).decision).toBe("deny");
      expect(engine.decide({ agent: "main", tool: "Shell", cwd: workspace, command: "pytest ambiguous-target" }).decision).toBe("ask");
      expect(engine.decide({ agent: "main", tool: "Shell", cwd: workspace, command: "npm test" }).decision).toBe("allow");
    }
  });

  it("does not auto-allow cmd indirections or unproven wrappers in full mode", () => {
    const workspace = mkdtempSync(join(tmpdir(), "flavor-workspace-"));
    const engine = new PermissionEngine({ workspace, mode: "full" });
    expect(engine.decide({ agent: "main", tool: "Shell", command: "cmd /c call format C:" }).decision).toBe("deny");
    expect(engine.decide({ agent: "main", tool: "Shell", command: "cmd /c echo ok" }).decision).toBe("ask");
    expect(engine.decide({ agent: "main", tool: "Shell", command: "sh -c 'echo ok'" }).decision).toBe("ask");
  });

  it("defaults to workspace mode", () => {
    const workspace = mkdtempSync(join(tmpdir(), "flavor-workspace-"));
    const outside = mkdtempSync(join(tmpdir(), "flavor-outside-"));
    const engine = new PermissionEngine({ workspace });
    expect(engine.decide({ agent: "main", tool: "Write", paths: [join(workspace, "x")] }).decision).toBe("ask");
    expect(engine.decide({ agent: "main", tool: "Write", paths: [join(outside, "x")] }).decision).toBe("ask");
  });
});
