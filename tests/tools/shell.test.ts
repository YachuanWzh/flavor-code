import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { createShellTool } from "../../src/tools/shell.js";

const node = process.execPath;
const signal = new AbortController().signal;

describe("Shell", () => {
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
});
