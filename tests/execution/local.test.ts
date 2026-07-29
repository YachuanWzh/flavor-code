import { describe, expect, it } from "vitest";

import { LocalExecutionEnvironment } from "../../src/execution/local.js";

describe("LocalExecutionEnvironment", () => {
  it("preserves the existing shell timeout and output behavior", async () => {
    const environment = new LocalExecutionEnvironment();
    const result = await environment.exec({
      command: process.execPath,
      args: ["-e", "process.stdout.write('local')"],
      cwd: process.cwd(),
      timeoutMs: 5_000,
    });
    expect(result).toMatchObject({ exitCode: 0, stdout: "local", terminationReason: null });
  });
});
