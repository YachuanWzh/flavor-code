import { spawn } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { prepareSpawnInvocation, resolveExecutablePath } from "../../src/utils/spawn-executable.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("prepareSpawnInvocation", () => {
  it.runIf(process.platform === "win32")("prefers Windows shims over extensionless POSIX scripts", async () => {
    const root = await mkdtemp(join(tmpdir(), "flavor-spawn-shim-")); roots.push(root);
    await writeFile(join(root, "npm"), "#!/bin/sh\n");
    await writeFile(join(root, "npm.cmd"), "@echo off\r\n");
    expect(resolveExecutablePath("npm", { cwd: root, env: { PATH: root, PATHEXT: ".EXE;.CMD" } })?.toLowerCase()).toBe(join(root, "npm.cmd").toLowerCase());
  });
  it("preserves structured commands outside Windows", () => {
    expect(prepareSpawnInvocation("npm", ["run", "check value"], { platform: "linux" }))
      .toEqual({ command: "npm", args: ["run", "check value"] });
  });

  it.runIf(process.platform === "win32")("bridges cmd shims through ComSpec on Windows", async () => {
    const root = await mkdtemp(join(tmpdir(), "flavor-spawn-")); roots.push(root);
    const shim = join(root, "example.cmd");
    await writeFile(shim, "@echo off\r\nnode -e \"process.stdout.write(JSON.stringify(process.argv.slice(1)))\" %*\r\n", "utf8");
    await chmod(shim, 0o755);

    const invocation = prepareSpawnInvocation("example", ["value with spaces", "a&b"], {
      platform: "win32",
      env: { PATH: `${root}${delimiter}${process.env.PATH ?? ""}`, PATHEXT: ".EXE;.CMD", ComSpec: process.env.ComSpec },
    });

    expect(invocation.command.toLocaleLowerCase()).toContain("cmd.exe");
    expect(invocation.args.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
    expect(invocation.args[3]?.toLocaleLowerCase()).toContain("example.cmd");
    expect(invocation.windowsVerbatimArguments).toBe(true);

    const output = await new Promise<string>((resolvePromise, reject) => {
      const child = spawn(invocation.command, invocation.args, {
        windowsVerbatimArguments: invocation.windowsVerbatimArguments,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
      child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
      child.once("error", reject);
      child.once("close", (code) => code === 0 ? resolvePromise(stdout) : reject(new Error(stderr || `exit ${code}`)));
    });
    expect(JSON.parse(output)).toEqual(["value with spaces", "a&b"]);
  });

  it.runIf(process.platform === "win32")("searches the Windows working directory before PATH", async () => {
    const root = await mkdtemp(join(tmpdir(), "flavor-cwd-spawn-")); roots.push(root);
    const executable = join(root, "local-tool.cmd");
    await writeFile(executable, "@echo off\r\n", "utf8");

    expect(resolveExecutablePath("local-tool", {
      platform: "win32", cwd: root, env: { PATH: "", PATHEXT: ".EXE;.CMD" },
    })?.toLocaleLowerCase()).toBe(executable.toLocaleLowerCase());
  });

  it.runIf(process.platform === "win32")("bridges only real batch files through cmd.exe", async () => {
    const root = await mkdtemp(join(tmpdir(), "flavor-non-batch-")); roots.push(root);
    const script = join(root, "script.ps1");
    await writeFile(script, "Write-Output ok\r\n", "utf8");

    expect(prepareSpawnInvocation(script, ["value"], {
      platform: "win32", env: { PATH: root, PATHEXT: ".PS1", ComSpec: process.env.ComSpec },
    })).toEqual({ command: script, args: ["value"] });
  });
});
