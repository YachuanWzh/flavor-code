import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createProgram } from "../../src/cli.js";

const execFileAsync = promisify(execFile);

const bundledCli = path.resolve("dist/cli.js");

describe("flavor CLI", () => {
  it("uses the public command name and package version", async () => {
    const program = createProgram();
    const manifest = JSON.parse(await readFile("package.json", "utf8")) as { version: string };
    expect(program.name()).toBe("flavor");
    expect(program.version()).toBe(manifest.version);
    expect(manifest.version).toBe("1.2.4");
    expect(program.options.find((option) => option.long === "--resume")?.optional).toBe(true);
  });

  // Building the bundle inline made this test exceed its timeout on slow CI
  // runners and leak the tsup child process, wedging the whole suite. CI
  // builds before testing; locally the check is skipped until `npm run build`
  // has produced dist/cli.js.
  it.skipIf(!existsSync(bundledCli))("prints the package version when executed", async () => {
    const { stdout } = await execFileAsync(process.execPath, [bundledCli, "--version"]);

    expect(stdout.trim()).toBe("1.2.4");
  }, 15_000);
});
