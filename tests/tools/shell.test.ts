import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { createShellTool } from "../../src/tools/shell.js";
import { JobRegistry } from "../../src/jobs/registry.js";

const node = process.execPath;
const signal = new AbortController().signal;

describe("Shell", () => {
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

  it("reports non-zero exits", async () => {
    const result = await createShellTool(process.cwd()).execute({
      command: node, args: ["-e", "process.stderr.write('bad'); process.exit(7)"],
    }, signal);

    expect(result).toMatchObject({ exitCode: 7, signal: null, stderr: "bad", truncated: false });
  });

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
    expect(invalid.exitCode).not.toBe(0);
    expect(`${invalid.stdout}${invalid.stderr}`).not.toContain("�");
  });

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
