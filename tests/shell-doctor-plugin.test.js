// tests/shell-doctor-plugin.test.js
// Behavior tests for the disk plugin at .flavor/plugins/shell-doctor.
// Written in JS because the plugin ships untyped sandbox-safe ESM; vitest
// picks this up via its default include, tsc skips it (no allowJs).

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { classifyFailure, createShellDoctor } from "../.flavor/plugins/shell-doctor/core.js";
import { activate } from "../.flavor/plugins/shell-doctor/index.js";
import { PluginManifestSchema } from "../src/plugins/types.js";

const WIN_WS = "C:\\Users\\dev\\idea\\proj";
const MAC_WS = "/Users/dev/proj";

describe("classifyFailure: windows bash-syntax mismatch", () => {
  it("flags a bash pipeline sent to the Windows cmd shell", () => {
    const verdict = classifyFailure({
      tool: "Shell",
      input: { command: "sh", args: ["-c", "grep -rl cancelOrder src | head -20 2>/dev/null"] },
      text: 'System cannot find the path specified.\r\nGet "null": unexpected. This shell is reserved for running Windows PowerShell commands.',
      workspace: WIN_WS,
    });
    expect(verdict).toBeDefined();
    expect(verdict.ruleId).toBe("win-bash-mismatch");
    expect(verdict.note).toMatch(/PowerShell|cmd/i);
    expect(verdict.note).toMatch(/Glob|Grep|read_external/);
  });
});

describe("classifyFailure: posix shell given cmd-style syntax", () => {
  it("flags cmd redirection and drive paths on a POSIX workspace", () => {
    const verdict = classifyFailure({
      tool: "Shell",
      input: { command: "bash", args: ["-c", "type README.md 2>nul; dir C:\\Users\\dev\\proj\\src"] },
      text: "bash: type: README.md: not found",
      workspace: MAC_WS,
    });
    expect(verdict).toBeDefined();
    expect(verdict.ruleId).toBe("posix-cmd-mismatch");
    expect(verdict.note).toMatch(/POSIX|macOS|zsh|bash/i);
  });
});

describe("classifyFailure: guessed file path", () => {
  it("flags an ENOENT from a path-shaped tool input", () => {
    const verdict = classifyFailure({
      tool: "Grep",
      input: { pattern: "cancelOrder", path: "src/services/order-service.ts" },
      text: "ENOENT: no such file or directory, realpath 'C:\\Users\\dev\\proj\\src\\services\\order-service.ts'",
      workspace: WIN_WS,
    });
    expect(verdict).toBeDefined();
    expect(verdict.ruleId).toBe("bad-path-guess");
    expect(verdict.note).toMatch(/Glob|ast_search/);
  });
});

describe("classifyFailure: command not found", () => {
  it("flags a missing command on Windows", () => {
    const verdict = classifyFailure({
      tool: "Shell",
      input: { command: "rg", args: ["-l", "cancelOrder", "src"] },
      text: "'rg' is not recognized as an internal or external command,\r\noperable program or batch file.",
      workspace: WIN_WS,
    });
    expect(verdict).toBeDefined();
    expect(verdict.ruleId).toBe("command-not-found");
    expect(verdict.note).toMatch(/rg|install|Grep tool/i);
  });

  it("flags a missing command on macOS", () => {
    const verdict = classifyFailure({
      tool: "Shell",
      input: { command: "rg", args: ["-l", "cancelOrder", "src"] },
      text: "bash: rg: command not found",
      workspace: MAC_WS,
    });
    expect(verdict).toBeDefined();
    expect(verdict.ruleId).toBe("command-not-found");
  });
});

describe("classifyFailure: out-of-workspace path", () => {
  it("routes to read_external instead of retrying the built-in Read", () => {
    const verdict = classifyFailure({
      tool: "Read",
      input: { path: "C:\\Users\\dev\\notes\\design.md" },
      text: "Access denied: C:\\Users\\dev\\notes\\design.md is outside the workspace",
      workspace: WIN_WS,
    });
    expect(verdict).toBeDefined();
    expect(verdict.ruleId).toBe("out-of-workspace");
    expect(verdict.note).toMatch(/read_external/);
  });
});

const shellPostEvent = (overrides = {}) => ({
  tool: "Shell",
  agent: "main",
  input: { command: "sh", args: ["-c", "grep -rl cancelOrder src 2>/dev/null | head -20"] },
  output: {
    exitCode: 1, stdout: "",
    stderr: 'Get "null": unexpected. This shell is reserved for running Windows PowerShell commands.',
    terminationReason: null,
  },
  workspace: WIN_WS,
  ...overrides,
});

describe("createShellDoctor: failure ledger", () => {
  it("queues a corrective note after a failed shell call and drains it once on the next prompt", () => {
    const doctor = createShellDoctor();
    expect(doctor.onPostToolUse(shellPostEvent())).toEqual({ decision: "allow" });

    const submit = doctor.onUserPromptSubmit({ prompt: "continue" });
    expect(submit.decision).toBe("allow");
    expect(submit.additionalContext).toMatch(/win-bash-mismatch/);
    expect(submit.additionalContext).toMatch(/PowerShell/i);

    const second = doctor.onUserPromptSubmit({ prompt: "again" });
    expect(second.additionalContext).toBeUndefined();
  });

  it("does not record a successful shell call or a cancelled one", () => {
    const doctor = createShellDoctor();
    doctor.onPostToolUse(shellPostEvent({ output: { exitCode: 0, stdout: "ok", stderr: "", terminationReason: null } }));
    doctor.onPostToolUse(shellPostEvent({ output: { exitCode: null, stdout: "", stderr: "", terminationReason: "cancelled" } }));
    expect(doctor.onUserPromptSubmit({ prompt: "x" }).additionalContext).toBeUndefined();
  });
});

describe("createShellDoctor: repeat denial", () => {
  it("denies an exact retry of a categorized failed shell command with the note as reason", () => {
    const doctor = createShellDoctor();
    const event = shellPostEvent();
    const input = event.input;
    expect(doctor.onPreToolUse({ tool: "Shell", input, agent: "main", workspace: WIN_WS }).decision).toBe("allow");

    doctor.onPostToolUse(event);
    const denied = doctor.onPreToolUse({ tool: "Shell", input, agent: "main", workspace: WIN_WS });
    expect(denied.decision).toBe("deny");
    expect(denied.reason).toMatch(/win-bash-mismatch|PowerShell/);
    expect(denied.reason).toMatch(/already failed/i);
  });

  it("keeps allowing other commands and uncategorized failures", () => {
    const doctor = createShellDoctor();
    const event = shellPostEvent({
      input: { command: "npm", args: ["test"] },
      output: { exitCode: 1, stdout: "1 test failed", stderr: "", terminationReason: null },
    });
    doctor.onPostToolUse(event);
    expect(doctor.onPreToolUse({ tool: "Shell", input: { command: "npm", args: ["test"] }, agent: "main", workspace: WIN_WS }).decision).toBe("allow");
    expect(doctor.onPreToolUse({ tool: "Shell", input: { command: "git", args: ["status"] }, agent: "main", workspace: WIN_WS }).decision).toBe("allow");
  });
});

describe("plugin wiring", () => {
  it("declares a valid manifest with exactly the four consumed hook events and no permissions", () => {
    const manifest = PluginManifestSchema.parse(
      JSON.parse(readFileSync(".flavor/plugins/shell-doctor/flavor-plugin.json", "utf8")),
    );
    expect(manifest.name).toBe("shell-doctor");
    expect(manifest.permissions).toEqual([]);
    expect(manifest.contributes.hooks.map((h) => h.name).sort()).toEqual(
      ["PostToolUse", "PostToolUseFailure", "PreToolUse", "UserPromptSubmit"],
    );
  });

  it("activate registers handlers that consume hook events and return decisions", () => {
    const hooks = {};
    const dispose = activate({
      signal: { aborted: false },
      config: undefined,
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      services: { filesystem: {} },
      registerCommand() { throw new Error("shell-doctor registers no commands"); },
      registerTool() { throw new Error("shell-doctor registers no tools"); },
      registerSkillRoot() { throw new Error("shell-doctor registers no skill roots"); },
      registerModelAdapter() { throw new Error("shell-doctor registers no model adapters"); },
      registerHook(name, handler) {
        hooks[name] = handler;
        return () => { delete hooks[name]; };
      },
    });
    expect(typeof dispose).toBe("function");
    expect(Object.keys(hooks).sort()).toEqual(
      ["PostToolUse", "PostToolUseFailure", "PreToolUse", "UserPromptSubmit"],
    );

    const post = { version: 1, type: "PostToolUse", payload: shellPostEvent() };
    expect(hooks.PostToolUse(post)).toEqual({ decision: "allow" });
    const repeated = hooks.PreToolUse({
      version: 1, type: "PreToolUse",
      payload: { tool: "Shell", input: post.payload.input, agent: "main" },
    });
    expect(repeated.decision).toBe("deny");
    expect(hooks.UserPromptSubmit({ version: 1, type: "UserPromptSubmit", payload: { prompt: "go" } }))
      .toMatchObject({ decision: "allow" });
    expect(hooks.PostToolUseFailure({
      version: 1, type: "PostToolUseFailure",
      payload: { tool: "Glob", input: { pattern: "x", path: "C:\\outside\\y" }, agent: "main", error: { code: "invalid_input", message: "is outside the workspace" } },
    })).toEqual({ decision: "allow" });
    dispose();
    expect(hooks.PostToolUse).toBeUndefined();
  });
});
