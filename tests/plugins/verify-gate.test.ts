import { describe, expect, it } from "vitest";

// @ts-expect-error - plain JS plugin core, no type declarations
import { createVerifyGate } from "../../.flavor/plugins/verify-gate/core.js";

function shellOk(command: string, args: string[] = []) {
  return { tool: "Shell", input: { command, args }, output: { exitCode: 0, stdout: "", stderr: "" } };
}

describe("verify-gate", () => {
  it("lets a clean session stop untouched", async () => {
    const gate = createVerifyGate();
    const stop = await gate.onStop({ outcome: "completed" });
    expect(stop.decision).toBe("allow");
  });

  it("vetoed a stop right after source edits with no verification run", async () => {
    const gate = createVerifyGate();
    await gate.onPostToolUse({ tool: "Write", input: { path: "src/auth/login.ts", content: "export const x = 1;" } });
    const stop = await gate.onStop({ outcome: "completed" });
    expect(stop.decision).toBe("deny");
    expect(stop.reason).toContain("src/auth/login.ts");
  });

  it("clears the dirty set after a successful test run, then re-arms on new edits", async () => {
    const gate = createVerifyGate();
    await gate.onPostToolUse({ tool: "Edit", input: { path: "src/a.ts", oldText: "1", newText: "2" } });
    await gate.onPostToolUse(shellOk("npx", ["vitest", "run"]));
    expect((await gate.onStop({ outcome: "completed" })).decision).toBe("allow");
    await gate.onPostToolUse({ tool: "Write", input: { path: "src/b.ts", content: "export const y = 2;" } });
    expect((await gate.onStop({ outcome: "completed" })).decision).toBe("deny");
  });

  it("accepts common verification commands and rejects unrelated shells", async () => {
    const gate = createVerifyGate();
    await gate.onPostToolUse({ tool: "Write", input: { path: "src/a.ts", content: "x" } });
    await gate.onPostToolUse(shellOk("ls"));
    expect((await gate.onStop({ outcome: "completed" })).decision).toBe("deny");
    await gate.onPostToolUse(shellOk("npm", ["test"]));
    expect((await gate.onStop({ outcome: "completed" })).decision).toBe("allow");
    await gate.onPostToolUse({ tool: "Write", input: { path: "src/a.ts", content: "x2" } });
    await gate.onPostToolUse(shellOk("npm", ["run", "build"]));
    expect((await gate.onStop({ outcome: "completed" })).decision).toBe("allow");
  });

  it("ignores docs, generated and plugin-local files", async () => {
    const gate = createVerifyGate();
    await gate.onPostToolUse({ tool: "Write", input: { path: "README.md", content: "# hi" } });
    await gate.onPostToolUse({ tool: "Write", input: { path: "dist/bundle.js", content: "x" } });
    await gate.onPostToolUse({ tool: "Edit", input: { path: ".flavor/plugins/time-plugin/index.js", oldText: "a", newText: "b" } });
    expect((await gate.onStop({ outcome: "completed" })).decision).toBe("allow");
  });

  it("does not veto cancelled or already-failing turns, and bounds the file list", async () => {
    const gate = createVerifyGate();
    for (let i = 0; i < 20; i++) await gate.onPostToolUse({ tool: "Write", input: { path: `src/f${i}.ts`, content: "x" } });
    expect((await gate.onStop({ outcome: "cancelled" })).decision).toBe("allow");
    expect((await gate.onStop({ outcome: "failed" })).decision).toBe("allow");
    const stop = await gate.onStop({ outcome: "completed" });
    expect(stop.decision).toBe("deny");
    expect((stop.reason.match(/src\/f\d+\.ts/g) ?? []).length).toBeLessThanOrEqual(10);
  });
});
