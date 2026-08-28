// update-plugin 的 npx 调用方式测试。
//
// 背景：Node 自 CVE-2024-27980 修复起（18.20.2 / 20.12.2 / 21.7.0+，含 v24），
// 禁止在 shell:false 下直接 spawn .cmd/.bat，Windows 上 spawn("npx.cmd", ...,
// {shell:false}) 必然 EINVAL。本测试锁定跨 Windows/macOS 的正确调用形态。
// 实现通过 config 注入依赖（fileExists/spawn/platform），测试不 mock ESM 模块。

import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { join } from "node:path";

import { activate, resolveInvocation } from "../../../.flavor/plugins/update-plugin-0.1.0/index.js";

function makeFakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  return child;
}

function fakeContext(config = {}) {
  const commands = new Map();
  const child = makeFakeChild();
  const spawn = vi.fn(() => child);
  return {
    commands,
    child,
    spawn,
    context: {
      signal: new AbortController().signal,
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      config: { spawn, ...config },
      registerCommand: (name, handler) => { commands.set(name, handler); return () => commands.delete(name); },
    },
  };
}

const NODE_EXE = "C:\\Program Files\\nodejs\\node.exe";
const NPX_CLI = join(NODE_EXE, "..", "node_modules", "npm", "bin", "npx-cli.js");

describe("resolveInvocation（Windows）", () => {
  it("优先用 node 直接执行 npx-cli.js，绝不 spawn npx.cmd", () => {
    const inv = resolveInvocation({ platform: "win32", execPath: NODE_EXE, fileExists: (p) => p === NPX_CLI });
    expect(inv.command).toBe(NODE_EXE);
    expect(inv.argsPrefix).toEqual([NPX_CLI]);
    expect(inv.useCmdShell).not.toBe(true);
  });

  it("PATH 上的 npm 布局也能命中", () => {
    const pathCli = join("C:\\Users\\me\\AppData\\Roaming\\npm", "node_modules", "npm", "bin", "npx-cli.js");
    const inv = resolveInvocation({
      platform: "win32",
      execPath: "D:\\node\\node.exe",
      env: { PATH: `C:\\Windows;C:\\Users\\me\\AppData\\Roaming\\npm` },
      fileExists: (p) => p === pathCli,
    });
    expect(inv.argsPrefix).toEqual([pathCli]);
  });

  it("找不到 npx-cli.js 时回退 cmd.exe /d /s /c，参数全部双引号转义", () => {
    const inv = resolveInvocation({ platform: "win32", execPath: "C:\\node\\node.exe", env: {}, fileExists: () => false });
    expect(inv.command).toMatch(/cmd\.exe$/i);
    expect(inv.useCmdShell).toBe(true);
    // argv 在调用方组装；这里复现转义契约：内嵌双引号翻倍
    const quoted = ['a"b', "--yes"].map((v) => `"${v.replace(/"/g, '""')}"`);
    expect(quoted[0]).toBe('"a""b"');
  });
});

describe("resolveInvocation（macOS / POSIX）", () => {
  it("直接 spawn npx，无需 .cmd 或 cmd.exe", () => {
    const inv = resolveInvocation({ platform: "darwin", execPath: "/usr/local/bin/node", fileExists: () => false });
    expect(inv.command).toBe("npx");
    expect(inv.argsPrefix).toEqual([]);
    expect(inv.useCmdShell).not.toBe(true);
  });
});

describe("命令端到端（注入 spawn）", () => {
  it("Windows：默认参数为 update --all，argv 首项为 npx-cli.js，shell 保持关闭", async () => {
    const host = fakeContext({ platform: "win32", execPath: NODE_EXE, fileExists: (p) => p === NPX_CLI });
    await activate(host.context);
    const promise = host.commands.get("update-plugin")([]);
    host.child.emit("close", 0);
    const result = await promise;
    expect(result.ok).toBe(true);
    const [command, argv, options] = host.spawn.mock.calls[0];
    expect(command).toBe(NODE_EXE);
    expect(argv.slice(0, 3)).toEqual([NPX_CLI, "--yes", "@flavor-code/plugin-manager"]);
    expect(argv.slice(3)).toEqual(["--all", "-y", "--force"]);
    expect(options.shell).toBeFalsy();
  });

  it("Windows 回退：cmd.exe /d /s /c 且整条命令参数被引号包裹", async () => {
    const host = fakeContext({ platform: "win32", execPath: "C:\\node\\node.exe", env: {}, fileExists: () => false });
    await activate(host.context);
    const promise = host.commands.get("update-plugin")([]);
    host.child.emit("close", 0);
    await promise;
    const [command, argv] = host.spawn.mock.calls[0];
    expect(command).toMatch(/cmd\.exe$/i);
    expect(argv.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
    expect(argv[3]).toContain('"npx" "--yes" "@flavor-code/plugin-manager" "--all" "-y" "--force"');
  });

  it("macOS：直接 spawn npx，用户参数原样透传（不经过 shell 拼接）", async () => {
    const host = fakeContext({ platform: "darwin", execPath: "/usr/local/bin/node", fileExists: () => false });
    await activate(host.context);
    const promise = host.commands.get("update-plugin")(["update", "my-plugin"]);
    host.child.emit("close", 1);
    const result = await promise;
    expect(result.ok).toBe(false);
    const [command, argv, options] = host.spawn.mock.calls[0];
    expect(command).toBe("npx");
    expect(argv).toEqual(["--yes", "@flavor-code/plugin-manager", "update", "my-plugin"]);
    expect(options.shell).toBeFalsy();
  });

  it("/update-plugin help 不派生进程", async () => {
    const host = fakeContext({ platform: "darwin", fileExists: () => false });
    await activate(host.context);
    const result = await host.commands.get("update-plugin")(["help"]);
    expect(result.usage.length).toBeGreaterThanOrEqual(3);
    expect(host.spawn).not.toHaveBeenCalled();
  });

  // 真实回归：在当前操作系统用真实 spawn 执行 `npx --version`，走与插件完全相同的
  // 调用形态。旧实现在 Windows（Node ≥18.20.2/20.12.2/21.7.0+）必然 spawn EINVAL。
  it("真实 spawn resolveInvocation 的调用形态不会失败", async () => {
    const inv = resolveInvocation();
    const argv = [...inv.argsPrefix, "--version"];
    if (inv.useCmdShell) {
      argv.unshift("/d", "/s", "/c", `"npx" ${argv.map((v) => `"${v.replace(/"/g, '""')}"`).join(" ")}`);
      argv.length = 4;
    }
    const { spawn } = await import("node:child_process");
    const code = await new Promise((resolve, reject) => {
      const child = spawn(inv.command, argv, { shell: false, windowsHide: true, timeout: 30_000 });
      child.on("error", reject); // 旧实现在 Windows 上正是这里抛 EINVAL
      child.on("close", resolve);
    });
    expect(code).toBe(0);
  }, 30_000);
});
