import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createProgram } from "../../src/cli.js";

const execFileAsync = promisify(execFile);

describe("flavor CLI", () => {
  it("uses the public command name and package version", async () => {
    const program = createProgram();
    const manifest = JSON.parse(await readFile("package.json", "utf8")) as { version: string };
    expect(program.name()).toBe("flavor");
    expect(program.version()).toBe(manifest.version);
    expect(manifest.version).toBe("1.0.1");
    expect(program.options.find((option) => option.long === "--resume")?.optional).toBe(true);
  });

  it("prints the package version when executed", async () => {
    await execFileAsync(process.execPath, [path.resolve("node_modules/tsup/dist/cli-default.js")]);

    const { stdout } = await execFileAsync(process.execPath, [path.resolve("dist/cli.js"), "--version"]);

    expect(stdout.trim()).toBe("1.0.1");
  });
});
