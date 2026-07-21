import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createProgram } from "../../src/cli.js";

const execFileAsync = promisify(execFile);

describe("flavor CLI", () => {
  it("uses the public command name and package version", () => {
    const program = createProgram();
    expect(program.name()).toBe("flavor");
    expect(program.version()).toMatch(/^0\.5\.0$/);
    expect(program.options.find((option) => option.long === "--resume")?.optional).toBe(true);
  });

  it("prints the package version when executed", async () => {
    await execFileAsync(process.execPath, [path.resolve("node_modules/tsup/dist/cli-default.js")]);

    const { stdout } = await execFileAsync(process.execPath, [path.resolve("dist/cli.js"), "--version"]);

    expect(stdout.trim()).toBe("0.5.0");
  });
});
