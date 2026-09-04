import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { createShellTool, normalizeShellCommand } from "../../src/tools/shell.js";
import { JobRegistry } from "../../src/jobs/registry.js";

const node = process.execPath;
const signal = new AbortController().signal;

describe("normalizeShellCommand", () => {
  it("splits a whole command line stuffed into command when the head is a bare command name", () => {
    expect(normalizeShellCommand({ command: "dir /b", args: [] })).toEqual({ command: "dir", args: ["/b"] });
    expect(normalizeShellCommand({ command: "git log --oneline -3", args: [] })).toEqual({
      command: "git", args: ["log", "--oneline", "-3"],
    });
    expect(normalizeShellCommand({ command: "npm run build", args: [] })).toEqual({
      command: "npm", args: ["run", "build"],
    });
  });

  it("respects double quotes so quoted arguments keep their meaning", () => {
    expect(normalizeShellCommand({ command: 'echo "a b" c', args: [] })).toEqual({
      command: "echo", args: ["a b", "c"],
    });
    expect(normalizeShellCommand({ command: 'node -e "process.stdout.write(\'hi\')"', args: [] })).toEqual({
      command: "node", args: ["-e", "process.stdout.write('hi')"],
    });
    expect(normalizeShellCommand({ command: "node -e 'process.stdout.write(\"hello world\")'", args: [] })).toEqual({
      command: "node", args: ["-e", 'process.stdout.write("hello world")'],
    });
  });

  it("leaves explicit program paths with spaces untouched", () => {
    expect(normalizeShellCommand({ command: "C:\\Program Files\\node.exe --version", args: [] })).toEqual({
      command: "C:\\Program Files\\node.exe --version", args: [],
    });
    expect(normalizeShellCommand({ command: "/usr/local/bin/my tool --flag", args: [] })).toEqual({
      command: "/usr/local/bin/my tool --flag", args: [],
    });
  });

  it("keeps existing arg arrays untouched and merges extras from a stuffed command", () => {
    expect(normalizeShellCommand({ command: node, args: ["-e", "1"] })).toEqual({ command: node, args: ["-e", "1"] });
    expect(normalizeShellCommand({ command: node, args: [] })).toEqual({ command: node, args: [] });
    expect(normalizeShellCommand({ command: "git log", args: ["--oneline"] })).toEqual({
      command: "git", args: ["log", "--oneline"],
    });
  });

  it("does not split a single token even when quoted", () => {
    expect(normalizeShellCommand({ command: '"C:\\Program Files\\node.exe"', args: [] })).toEqual({
      command: "C:\\Program Files\\node.exe", args: [],
    });
  });

  it("repairs quoted cmd payloads without discarding switches", () => {
    expect(normalizeShellCommand({ command: "cmd", args: ["/c", '"dir"', "/b", "src"] })).toEqual({
      command: "cmd", args: ["/c", "dir", "/b", "src"],
    });
  });

  it("keeps shell expansions and unmatched quotes out of argv normalization", () => {
    expect(normalizeShellCommand({ command: "echo $HOME", args: [] })).toEqual({ command: "echo $HOME", args: [] });
    expect(normalizeShellCommand({ command: "echo *.ts", args: [] })).toEqual({ command: "echo *.ts", args: [] });
    expect(normalizeShellCommand({ command: 'echo "unterminated', args: [] })).toEqual({ command: 'echo "unterminated', args: [] });
  });
});

describe("Shell", () => {
  it("rejects empty commands and null bytes at the tool boundary", () => {
    const schema = createShellTool(process.cwd()).inputSchema;
    expect(() => schema.parse({ command: "   ", args: [] })).toThrow();
    expect(() => schema.parse({ command: "node\0bad", args: [] })).toThrow();
    expect(() => schema.parse({ command: "node", args: ["bad\0arg"] })).toThrow();
  });

  it.skipIf(process.platform !== "win32")("runs PowerShell syntax via the detected shell instead of cmd.exe", async () => {
    const result = await createShellTool(process.cwd()).execute({
      // cmd.exe has no Write-Output; a PowerShell-family shell prints the argument.
      command: "Write-Output",
      args: ["pwsh-works"],
    }, signal);
    expect(result).toMatchObject({ exitCode: 0 });
    expect(result.stdout.trim()).toBe("pwsh-works");
  });

  it("returns immediately for background commands and exposes incremental job output", async () => {
    const jobs = new JobRegistry();
    const tool = createShellTool(process.cwd(), { jobs });
    const result = await tool.execute({
      command: node, args: ["-e", "process.stdout.write('ready')"], background: true,
    }, signal, { agent: "main" });
    expect(result).toMatchObject({ state: "running", jobId: expect.stringMatching(/^job-/) });
    if (!("jobId" in result)) throw new Error("expected background result");
    expect(tool.presentResult?.(result, {
      command: node, args: ["-e", "process.stdout.write('ready')"], background: true,
    })).toMatchObject({ kind: "job", action: "start", id: result.jobId, state: "running" });
    await jobs.wait(result.jobId, "main");
    expect(jobs.read(result.jobId, "main").output).toContain("ready");
  });
  it("preserves structured failure diagnostics on background jobs", async () => {
    const jobs = new JobRegistry();
    const tool = createShellTool(process.cwd(), { jobs });
    const result = await tool.execute({
      command: node, args: ["-e", "process.stderr.write('raw failure');process.exit(9)"], background: true,
    }, signal, { agent: "main" });
    if (!("jobId" in result)) throw new Error("expected background result");
    await jobs.wait(result.jobId, "main");
    expect(jobs.read(result.jobId, "main")).toMatchObject({
      state: "failed", exitCode: 9, error: "Command exited with code 9.",
      output: "[stderr] raw failure",
    });
  });
  it("accepts string-form booleans for background (weak-typed models emit \"true\")", async () => {
    const jobs = new JobRegistry();
    const tool = createShellTool(process.cwd(), { jobs });
    expect(tool.inputSchema.parse({ command: node, args: [], background: true }).background).toBe(true);
    expect(tool.inputSchema.parse({ command: node, args: [], background: "true" }).background).toBe("true");
    expect(tool.inputSchema.parse({ command: node, args: [], background: "false" }).background).toBe("false");
    expect(() => tool.inputSchema.parse({ command: node, args: [], background: "yes" })).toThrow();

    const result = await tool.execute({
      command: node, args: ["-e", "process.stdout.write('up')"], background: "true",
    }, signal, { agent: "main" });
    expect(result).toMatchObject({ state: "running", jobId: expect.stringMatching(/^job-/) });
    expect(tool.presentCall?.({ command: node, args: [], background: "true" })).toMatchObject({ title: "Starting background command" });
    if (!("jobId" in result)) throw new Error("expected background result");
    await jobs.wait(result.jobId, "main");
  });
  it("passes argument arrays without shell parsing and uses a workspace cwd", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "flavor shell "));
    const result = await createShellTool(workspace).execute({
      command: node,
      args: ["-e", "process.stdout.write(JSON.stringify({arg:process.argv[1],cwd:process.cwd()}))", "two words"],
    }, signal);

    expect(JSON.parse(result.stdout)).toEqual({ arg: "two words", cwd: workspace });
    expect(result.exitCode).toBe(0);
    expect(result.signal).toBeNull();
  });

  it("preserves metacharacters and whitespace as exact argv values", async () => {
    const result = await createShellTool(process.cwd()).execute({
      command: node,
      args: ["-e", "process.stdout.write(process.argv.slice(1).join('\\n'))", "a&b", "two words", "quoted\"value"],
    }, signal);

    expect(result).toMatchObject({ exitCode: 0, stdout: "a&b\ntwo words\nquoted\"value" });
  });

  it("makes project-local node_modules binaries available without npx", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "flavor-local-bin-"));
    const bin = join(workspace, "node_modules", ".bin");
    mkdirSync(bin, { recursive: true });
    if (process.platform === "win32") {
      writeFileSync(join(bin, "local-fixture-tool.cmd"), "@echo off\r\necho local-bin-ok\r\n", "utf8");
    } else {
      const executable = join(bin, "local-fixture-tool");
      writeFileSync(executable, "#!/bin/sh\nprintf local-bin-ok\n", "utf8");
      chmodSync(executable, 0o755);
    }

    const result = await createShellTool(workspace).execute({ command: "local-fixture-tool", args: [] }, signal);
    expect(result).toMatchObject({ exitCode: 0 });
    expect(result.stdout.trim()).toBe("local-bin-ok");
  });

  it.skipIf(process.platform !== "win32")("repairs and runs the cmd invocation shown by shell failure reports", async () => {
    const result = await createShellTool(process.cwd()).execute({
      command: "cmd", args: ["/c", '"dir"', "/b", "src"],
    }, signal);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("tools");
    expect(result.stderr).toBe("");
    expect(result.diagnostic).toBeUndefined();
  });

  it("uses the selected runtime shell only for explicit shell syntax", async () => {
    const command = process.platform === "win32"
      ? "Write-Output left,right | Select-Object -Last 1"
      : "printf 'left\\nright\\n' | tail -n 1";
    const result = await createShellTool(process.cwd()).execute({ command, args: [] }, signal);

    expect(result).toMatchObject({ exitCode: 0 });
    expect(result.stdout.trim()).toBe("right");
  });

  it("does not silently drop args supplied with a shell expression", async () => {
    const command = process.platform === "win32"
      ? "Write-Output base; Write-Output"
      : "printf base; printf";
    const result = await createShellTool(process.cwd()).execute({ command, args: ["-suffix"] }, signal);

    expect(result.exitCode).toBe(0);
    expect(result.stdout.replace(/\r?\n/gu, "")).toBe("base-suffix");
  });

  it("expands runtime-shell environment variables in explicit shell expressions", async () => {
    const environment = { ...process.env, FLAVOR_SHELL_EXPANSION: "expanded-value" };
    const command = process.platform === "win32"
      ? "Write-Output $env:FLAVOR_SHELL_EXPANSION"
      : "printf \"$FLAVOR_SHELL_EXPANSION\"";
    const result = await createShellTool(process.cwd(), { environment }).execute({ command, args: [] }, signal);

    expect(result).toMatchObject({ exitCode: 0 });
    expect(result.stdout.trim()).toBe("expanded-value");
  });

  it("reports unmatched shell quotes instead of executing them as literal argv", async () => {
    const result = await createShellTool(process.cwd()).execute({ command: 'echo "unterminated', args: [] }, signal);

    expect(result.exitCode).not.toBe(0);
    expect(result.diagnostic).toMatchObject({ kind: "shell-syntax" });
  });

  it("runs a whole command line stuffed into command (Windows-friendly)", async () => {
    const result = await createShellTool(process.cwd()).execute({
      command: `node -e "process.stdout.write('compat-ok')"`, args: [],
    }, signal);
    expect(result).toMatchObject({ exitCode: 0, stdout: "compat-ok" });
  });

  it("normalizes command and args together when both are supplied", async () => {
    const result = await createShellTool(process.cwd()).execute({
      command: `node -e`, args: ["process.stdout.write('merged-ok')"],
    }, signal);
    expect(result).toMatchObject({ exitCode: 0, stdout: "merged-ok" });
  });

  it("reports non-zero exits", async () => {
    const result = await createShellTool(process.cwd()).execute({
      command: node, args: ["-e", "process.stderr.write('bad'); process.exit(7)"],
    }, signal);

    expect(result).toMatchObject({
      exitCode: 7, signal: null, stderr: "bad", truncated: false,
      diagnostic: { kind: "non-zero-exit", message: "Command exited with code 7." },
    });
  });

  it("returns an accurate missing-path diagnostic instead of throwing", async () => {
    const missing = join(process.cwd(), "definitely-missing-flavor-command");
    const result = await createShellTool(process.cwd()).execute({ command: missing, args: [] }, signal);

    expect(result.exitCode).toBe(127);
    expect(result.stdout).toBe("");
    expect(result.diagnostic).toMatchObject({ kind: "path-not-found" });
  });

  it("classifies a missing bare executable reported by the runtime shell", async () => {
    const result = await createShellTool(process.cwd()).execute({
      command: "definitely-missing-flavor-command", args: [],
    }, signal);

    expect(result.exitCode).not.toBe(0);
    expect(result.diagnostic).toMatchObject({ kind: "command-not-found" });
  });

  // Runs three subprocesses (cmd UTF-8, node GBK, and a real npm call that
  // can hit the network), so allow well beyond the default 5s under parallel load.
  it.skipIf(process.platform !== "win32")("decodes non-ASCII cmd output as UTF-8", async () => {
    const result = await createShellTool(process.cwd()).execute({
      command: "cmd.exe", args: ["/d", "/c", "echo 中文错误"],
    }, signal);

    expect(result.stdout.trim()).toBe("中文错误");
    expect(result.stdout).not.toContain("�");

    const gbk = await createShellTool(process.cwd()).execute({
      command: node, args: ["-e", "process.stdout.write(Buffer.from('d6d0cec4b4edcef3','hex'))"],
    }, signal);
    expect(gbk.stdout).toBe("中文错误");

    const invalid = await createShellTool(process.cwd()).execute({
      command: "npm view node dist-tags --json", args: [],
    }, signal);
    // The compatibility layer splits the whole line into npm + args, so it may
    // actually succeed; this assertion only guards against replacement chars.
    expect(`${invalid.stdout}${invalid.stderr}`).not.toContain("�");
  }, 30_000);

  it.skipIf(process.platform !== "win32")("streams split GBK output to background jobs without replacement characters", async () => {
    const jobs = new JobRegistry();
    const tool = createShellTool(process.cwd(), { jobs });
    const script = "process.stdout.write(Buffer.from('d6','hex')); setTimeout(()=>process.stdout.write(Buffer.from('d0cec4b4edcef3','hex')),20)";
    const result = await tool.execute({ command: node, args: ["-e", script], background: true }, signal, { agent: "main" });
    if (!("jobId" in result)) throw new Error("expected background result");
    await jobs.wait(result.jobId, "main");
    const output = jobs.read(result.jobId, "main").output;
    expect(output).toContain("中文错误");
    expect(output).not.toContain("�");
  });

  it("decodes UTF-16LE output with and without a byte-order mark", async () => {
    const withBom = await createShellTool(process.cwd()).execute({
      command: node, args: ["-e", "process.stdout.write(Buffer.concat([Buffer.from([0xff,0xfe]),Buffer.from('hello 世界','utf16le')]))"],
    }, signal);
    expect(withBom.stdout).toBe("hello 世界");

    const withoutBom = await createShellTool(process.cwd()).execute({
      command: node, args: ["-e", "process.stdout.write(Buffer.from('plain text','utf16le'))"],
    }, signal);
    expect(withoutBom.stdout).toBe("plain text");
  });

  it("terminates commands on timeout", async () => {
    const result = await createShellTool(process.cwd()).execute({
      command: node, args: ["-e", "setInterval(() => {}, 1000)"], timeoutMs: 40,
    }, signal);

    expect(result.terminationReason).toBe("timeout");
    expect(result.exitCode !== null || result.signal !== null).toBe(true);
  });

  it("terminates commands on cancellation", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 40);
    const result = await createShellTool(process.cwd()).execute({
      command: node, args: ["-e", "setInterval(() => {}, 1000)"],
    }, controller.signal);

    expect(result.terminationReason).toBe("cancelled");
    expect(result.exitCode !== null || result.signal !== null).toBe(true);
  });

  it("retains the head and tail of bounded stdout and stderr", async () => {
    const result = await createShellTool(process.cwd(), { maxOutputBytes: 10 }).execute({
      command: node,
      args: ["-e", "process.stdout.write('abcdefghijklmno');process.stderr.write('ABCDEFGHIJKLMNO')"],
    }, signal);

    expect(result).toMatchObject({ stdout: "abcde…klmno", stderr: "ABCDE…KLMNO", truncated: true });
  });

  it("preserves output below the limit without overlapping its head and tail", async () => {
    const result = await createShellTool(process.cwd(), { maxOutputBytes: 10 }).execute({
      command: node, args: ["-e", "process.stdout.write('abcdefgh')"],
    }, signal);

    expect(result).toMatchObject({ stdout: "abcdefgh", truncated: false });
  });

  it("applies the same output bound to execution-environment results", async () => {
    const executionEnvironment = {
      kind: "docker" as const,
      exec: vi.fn(async () => ({
        exitCode: 0, signal: null, stdout: "abcdefghijklmno", stderr: "",
        terminationReason: null,
      })),
      dispose: vi.fn(async () => undefined),
    };
    const result = await createShellTool(process.cwd(), {
      maxOutputBytes: 10,
      defaultTimeoutMs: 321,
      executionEnvironment,
    }).execute({ command: "node", args: [], cwd: null }, signal);

    expect(result.stdout).toBe("abcde…klmno");
    expect(result.truncated).toBe(true);
    expect(result.truncation.stdout).toMatchObject({ truncated: true, originalBytes: 15, limitBytes: 10 });
    expect(executionEnvironment.exec).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: 321 }), signal);
  });

  it("applies a configurable default timeout when the caller omits one", async () => {
    const result = await createShellTool(process.cwd(), { defaultTimeoutMs: 30 }).execute({
      command: node, args: ["-e", "setInterval(() => {}, 1000)"],
    }, signal);

    expect(result.terminationReason).toBe("timeout");
  });

  it("reports per-stream truncation without splitting UTF-8 code points", async () => {
    const result = await createShellTool(process.cwd(), { maxOutputBytes: 5 }).execute({
      command: node, args: ["-e", "process.stdout.write('A😀BC😀D');process.stderr.write('small')"],
    }, signal);

    expect(result.truncation.stdout.truncated).toBe(true);
    expect(result.truncation.stderr.truncated).toBe(false);
    expect(result.stdout).not.toContain("�");
    expect(result.stderr).toBe("small");
  });

  it("distinguishes timeout and cancellation termination reasons", async () => {
    const timed = await createShellTool(process.cwd()).execute({
      command: node, args: ["-e", "setInterval(() => {}, 1000)"], timeoutMs: 20,
    }, signal);
    expect(timed.terminationReason).toBe("timeout");

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);
    const cancelled = await createShellTool(process.cwd()).execute({
      command: node, args: ["-e", "setInterval(() => {}, 1000)"],
    }, controller.signal);
    expect(cancelled.terminationReason).toBe("cancelled");
  });

  it("releases inherited output handles shortly after the direct child exits", async () => {
    const script = [
      "const {spawn}=require('node:child_process')",
      "const child=spawn(process.execPath,['-e','setTimeout(()=>{},10000)'],{stdio:['ignore',1,2]})",
      "process.stdout.write(String(child.pid))",
      "child.unref()",
    ].join(";");
    const startedAt = Date.now();
    const result = await createShellTool(process.cwd()).execute({ command: node, args: ["-e", script] }, signal);
    const descendant = Number(result.stdout);
    try {
      expect(result).toMatchObject({ exitCode: 0, signal: null, terminationReason: null });
      expect(Date.now() - startedAt).toBeLessThan(2_000);
    } finally {
      try { process.kill(descendant, "SIGKILL"); } catch { /* The inherited-stream close may already have ended it. */ }
    }
  });

  it.skipIf(process.platform === "win32")("kills a TERM-resistant descendant after its parent exits", async () => {
    const script = [
      "const {spawn}=require('node:child_process')",
      "const child=spawn(process.execPath,['-e',\"process.on('SIGTERM',()=>{});process.send('ready');setInterval(()=>{},1000)\"],{stdio:['ignore','ignore','ignore','ipc']})",
      "child.once('message',()=>process.stdout.write(String(child.pid)))",
      "setInterval(()=>{},1000)",
    ].join(";");
    const result = await createShellTool(process.cwd()).execute({ command: node, args: ["-e", script], timeoutMs: 500 }, signal);
    const descendant = Number(result.stdout);
    try {
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(() => process.kill(descendant, 0)).toThrow();
    } finally {
      try { process.kill(descendant, "SIGKILL"); } catch { /* Expected when escalation succeeded. */ }
    }
  });
});
