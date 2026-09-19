import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";

import { registerConfigCommands, type ConfigCliResult } from "../../src/config/cli.js";
import type { FlavorConfig } from "../../src/config/schema.js";

function fakeConfig(overrides: Record<string, unknown> = {}): FlavorConfig {
  return {
    maxSessions: 50,
    permissionMode: "default",
    language: "zh-CN",
    context: { windowTokens: 200_000 },
    providers: { openai: { type: "openai", apiKey: "sk-secret" } },
    ...overrides,
  } as unknown as FlavorConfig;
}

function harness(options: {
  config?: FlavorConfig;
  sources?: string[];
  setValue?: (cwd: string, home: string, key: string, value: unknown) => Promise<string>;
  unsetValue?: (cwd: string, key: string) => Promise<string>;
}) {
  const output: string[] = [];
  const program = new Command().exitOverride();
  const load = vi.fn(async (): Promise<ConfigCliResult> => ({
    config: options.config ?? fakeConfig(),
    sources: options.sources ?? ["C:\\work\\.flavor\\flavor.json"],
  }));
  registerConfigCommands(program, {
    load,
    redact: (config) => config,
    ...(options.setValue === undefined ? {} : { setValue: options.setValue }),
    ...(options.unsetValue === undefined ? {} : { unsetValue: options.unsetValue }),
    cwd: () => "C:\\work",
    home: () => "C:\\home",
    write: (text) => output.push(text),
  });
  return { program, output: () => output.join(""), load };
}

describe("flavor config CLI", () => {
  it("prints the redacted configuration as JSON", async () => {
    const { program, output } = harness({});
    await program.parseAsync(["node", "flavor", "config", "list", "--json"]);
    expect(JSON.parse(output())).toMatchObject({ maxSessions: 50, language: "zh-CN" });
  });

  it("lists merged sources", async () => {
    const { program, output } = harness({ sources: ["a.json", "b.json"] });
    await program.parseAsync(["node", "flavor", "config", "list", "--sources"]);
    expect(output()).toContain("a.json");
    expect(output()).toContain("b.json");
  });

  it("gets a scalar and a nested value by dot path", async () => {
    const { program, output } = harness({});
    await program.parseAsync(["node", "flavor", "config", "get", "language"]);
    expect(output()).toBe("zh-CN\n");

    const nested = harness({});
    await nested.program.parseAsync(["node", "flavor", "config", "get", "context.windowTokens"]);
    expect(nested.output()).toBe("200000\n");
  });

  it("rejects an unknown top-level key without reading config", async () => {
    const { program, load } = harness({});
    await expect(program.parseAsync(["node", "flavor", "config", "get", "bogusKey"])).rejects.toThrow(/Unknown configuration key/i);
    expect(load).not.toHaveBeenCalled();
  });

  it("parses JSON literals and plain strings when setting values", async () => {
    const setValue = vi.fn(async () => "C:\\work\\.flavor\\flavor.json");
    const { program, output } = harness({ setValue });

    await program.parseAsync(["node", "flavor", "config", "set", "maxSessions", "75"]);
    expect(setValue).toHaveBeenLastCalledWith("C:\\work", "C:\\home", "maxSessions", 75);

    await program.parseAsync(["node", "flavor", "config", "set", "permissionMode", "plan"]);
    expect(setValue).toHaveBeenLastCalledWith("C:\\work", "C:\\home", "permissionMode", "plan");

    await program.parseAsync(["node", "flavor", "config", "set", "sleep", "true"]);
    expect(setValue).toHaveBeenLastCalledWith("C:\\work", "C:\\home", "sleep", true);

    expect(output()).toContain("Set maxSessions in C:\\work\\.flavor\\flavor.json");
  });

  it("unsets a key", async () => {
    const unsetValue = vi.fn(async () => "C:\\work\\.flavor\\flavor.json");
    const { program } = harness({ unsetValue });
    await program.parseAsync(["node", "flavor", "config", "unset", "language"]);
    expect(unsetValue).toHaveBeenCalledWith("C:\\work", "language");
  });

  it("prints project and global config paths", async () => {
    const { program, output } = harness({});
    await program.parseAsync(["node", "flavor", "config", "path"]);
    expect(output()).toContain("project: C:\\work\\.flavor\\flavor.json");
    expect(output()).toContain("global:  C:\\home\\.flavor-code\\flavor.json");
  });
});
