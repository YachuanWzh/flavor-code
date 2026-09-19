import { Command } from "commander";
import { afterEach, describe, expect, it } from "vitest";

import { registerUsageCommands } from "../../src/usage/cli.js";

const line = (sessionId: string, cacheRead: number, total: number) => JSON.stringify({
  event: "flavor-usage", sessionId, provider: "openai", model: "gpt-5",
  inputTokens: total - cacheRead, cacheReadTokens: cacheRead, cacheCreationTokens: 0,
  totalInputTokens: total, cacheHitRatio: total > 0 ? cacheRead / total : 0,
});

function harness(read: () => Promise<string>) {
  const output: string[] = [];
  const program = new Command().exitOverride();
  registerUsageCommands(program, { read, write: (text) => output.push(text) });
  return { program, output: () => output.join("") };
}

afterEach(() => { delete process.env.FLAVOR_USAGE_FILE; });

describe("flavor usage CLI", () => {
  it("renders a human summary of cache usage", async () => {
    const { program, output } = harness(async () => [line("sess-1", 1_000, 2_000), line("sess-1", 3_000, 4_000)].join("\n"));
    await program.parseAsync(["node", "flavor", "usage"]);
    expect(output()).toContain("gpt-5");
    expect(output()).toContain("Total input tokens");
    expect(output()).toContain("66.7%");
  });

  it("prints a JSON summary", async () => {
    const { program, output } = harness(async () => line("sess-9", 250, 500));
    await program.parseAsync(["node", "flavor", "usage", "--json"]);
    const parsed = JSON.parse(output());
    expect(parsed).toMatchObject({ requests: 1, sessionId: "sess-9", cacheShare: 0.5 });
  });

  it("reports gracefully when no usage is recorded", async () => {
    const { program, output } = harness(async () => "");
    await program.parseAsync(["node", "flavor", "usage"]);
    expect(output()).toContain("No usage recorded");
  });

  it("prints the usage log path", async () => {
    process.env.FLAVOR_USAGE_FILE = "C:\\work\\.flavor\\usage.jsonl";
    const { program, output } = harness(async () => "");
    await program.parseAsync(["node", "flavor", "usage", "--path"]);
    expect(output().trim()).toBe("C:\\work\\.flavor\\usage.jsonl");
  });
});
