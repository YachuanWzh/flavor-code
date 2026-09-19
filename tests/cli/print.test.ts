import { describe, expect, it, vi } from "vitest";
import { runPrint } from "../../src/cli.js";
import type { ProductionRuntime } from "../../src/production.js";
import type { ProductionRuntimeOptions } from "../../src/production.js";
import { compileHeadlessToolAllowlist, matchesHeadlessAllowlist } from "../../src/production.js";

it("returns 2 only for startup failure and redacts credential-shaped errors", async () => {
  const errors: string[] = [];
  const code = await runPrint("hello", {
    createRuntime: async () => { throw new Error("apiKey=sk-super-secret"); },
    stdout: () => {}, stderr: (text) => errors.push(text),
  });
  expect(code).toBe(2); expect(errors.join(" ")).not.toContain("sk-super-secret");
});

it("returns 1 for prompt/Stop failure and always closes and disposes", async () => {
  const close = vi.fn(async () => {}); const dispose = vi.fn(async () => {});
  const runtime = {
    session: { start: async () => {}, submit: async () => { throw new Error("Stop failed"); }, close }, dispose,
  } as unknown as ProductionRuntime;
  const code = await runPrint("hello", { createRuntime: async () => runtime, stdout: () => {}, stderr: () => {} });
  expect(code).toBe(1); expect(close).toHaveBeenCalledOnce(); expect(dispose).toHaveBeenCalledOnce();
});

it("prints task snapshots as static progress without animation", async () => {
  const output: string[] = [];
  const createRuntime = async (options: ProductionRuntimeOptions) => ({
    session: {
      start: async () => {},
      submit: async () => {
        options.output({ type: "tasks", snapshot: {
          plan: { tasks: [{
            id: "test", subject: "Run tests", activeForm: "Running tests",
            status: "in_progress", dependencies: [],
          }] },
          subagents: { states: {} },
          foregroundTaskId: "test",
        } });
      },
      close: async () => {},
    },
    dispose: async () => {},
  } as unknown as ProductionRuntime);

  const code = await runPrint("test", { createRuntime, stdout: (text) => output.push(text), stderr: () => {} });

  expect(code).toBe(0);
  expect(output.join("")).toContain("· Running tests · running");
  expect(output.join("")).not.toMatch(/[⠋⠙⠹⠸]/u);
});

it("does not replay a restored transcript in print mode", async () => {
  const output: string[] = [];
  const createRuntime = async (options: ProductionRuntimeOptions) => ({
    restoredTranscript: {
      completed: [{
        id: 1,
        prompt: "old prompt",
        assistantText: "old answer",
        statusLines: [],
        blocks: [{ kind: "text", text: "old answer" }],
      }],
      nextId: 2,
    },
    session: {
      start: async () => {},
      submit: async () => { options.output({ type: "text", text: "new answer" }); },
      close: async () => {},
    },
    dispose: async () => {},
  } as unknown as ProductionRuntime);

  const code = await runPrint("continue", { createRuntime, stdout: (text) => output.push(text), stderr: () => {} }, "saved");

  expect(code).toBe(0);
  expect(output.join("")).toContain("new answer");
  expect(output.join("")).not.toMatch(/old prompt|old answer/);
});

it("waits for a restored long-task continuation without replaying the print prompt", async () => {
  const submit = vi.fn(async () => undefined);
  const whenIdle = vi.fn(async () => undefined);
  const runtime = {
    session: {
      rotationContinuationResumed: true,
      start: vi.fn(async () => undefined),
      submit,
      whenIdle,
      close: vi.fn(async () => undefined),
    },
    dispose: vi.fn(async () => undefined),
  } as unknown as ProductionRuntime;
  const code = await runPrint("/goal original", {
    createRuntime: async () => runtime, stdout: () => undefined, stderr: () => undefined,
  }, "session-saved", true);
  expect(code).toBe(0);
  expect(whenIdle).toHaveBeenCalledOnce();
  expect(submit).not.toHaveBeenCalled();
});

it("emits a single JSON result object for --output-format json", async () => {
  const output: string[] = [];
  let captured: ProductionRuntimeOptions | undefined;
  const createRuntime = async (options: ProductionRuntimeOptions) => {
    captured = options;
    return {
      sessionId: "session-42",
      session: {
        start: async () => {},
        submit: async () => {
          options.output({ type: "text", text: "hello " });
          options.output({ type: "text", text: "world" });
          options.output({ type: "usage", inputTokens: 10, outputTokens: 5, totalInputTokens: 120, totalOutputTokens: 40, cacheReadTokens: 90 });
        },
        close: async () => {},
      },
      dispose: async () => {},
    } as unknown as ProductionRuntime;
  };
  const code = await runPrint("hi", { createRuntime, stdout: (text) => output.push(text), stderr: () => {} }, undefined, false, {
    outputFormat: "json",
  });
  expect(code).toBe(0);
  expect(output).toHaveLength(1);
  const result = JSON.parse(output[0]!) as Record<string, unknown>;
  expect(result).toMatchObject({
    type: "result", subtype: "success", sessionId: "session-42", result: "hello world", exitCode: 0,
    usage: { inputTokens: 120, outputTokens: 40, cacheReadTokens: 90 },
  });
  expect(captured).toBeDefined();
});

it("streams one JSON line per event and a final result for --output-format stream-json", async () => {
  const lines: string[] = [];
  const createRuntime = async (options: ProductionRuntimeOptions) => ({
    sessionId: "session-7",
    session: {
      start: async () => {},
      submit: async () => { options.output({ type: "notice", message: "working" }); },
      close: async () => {},
    },
    dispose: async () => {},
  } as unknown as ProductionRuntime);
  const code = await runPrint("hi", {
    createRuntime,
    stdout: (text) => lines.push(...text.split("\n").filter((line) => line.length > 0)),
    stderr: () => {},
  }, undefined, false, { outputFormat: "stream-json" });
  expect(code).toBe(0);
  expect(lines).toHaveLength(2);
  expect(JSON.parse(lines[0]!)).toMatchObject({ type: "notice", message: "working" });
  expect(JSON.parse(lines[1]!)).toMatchObject({ type: "result", subtype: "success", sessionId: "session-7", exitCode: 0 });
});

it("forwards print options into the runtime factory", async () => {
  let captured: ProductionRuntimeOptions | undefined;
  const createRuntime = async (options: ProductionRuntimeOptions) => {
    captured = options;
    return {
      sessionId: "s",
      session: { start: async () => {}, submit: async () => {}, close: async () => {} },
      dispose: async () => {},
    } as unknown as ProductionRuntime;
  };
  await runPrint("hi", { createRuntime, stdout: () => {}, stderr: () => {} }, undefined, false, {
    outputFormat: "json", permissionMode: "acceptEdits", allowedTools: ["Read", "Shell(npm test:*)"], model: "openai:gpt-5",
  });
  expect(captured?.permissionMode).toBe("acceptEdits");
  expect(captured?.headlessToolAllowlist).toEqual(["Read", "Shell(npm test:*)"]);
  expect(captured?.modelOverride).toBe("openai:gpt-5");
});

it("keeps the plain-text contract unchanged for the default format", async () => {
  const output: string[] = [];
  const createRuntime = async (options: ProductionRuntimeOptions) => ({
    sessionId: "s",
    session: {
      start: async () => {},
      submit: async () => { options.output({ type: "text", text: "answer" }); },
      close: async () => {},
    },
    dispose: async () => {},
  } as unknown as ProductionRuntime);
  const code = await runPrint("hi", { createRuntime, stdout: (text) => output.push(text), stderr: () => {} });
  expect(code).toBe(0);
  expect(output.join("")).toBe("answer\n");
});

describe("headless tool allowlist", () => {
  const entries = compileHeadlessToolAllowlist(["Read", "mcp__docs__*", "Shell(npm test:*)", "", "Broken(", "Shell(missing-wildcard)"]);

  it("matches exact tool names", () => {
    expect(matchesHeadlessAllowlist(entries, { tool: "Read" })).toBe(true);
    expect(matchesHeadlessAllowlist(entries, { tool: "Write" })).toBe(false);
  });

  it("matches tool name prefixes", () => {
    expect(matchesHeadlessAllowlist(entries, { tool: "mcp__docs__search" })).toBe(true);
    expect(matchesHeadlessAllowlist(entries, { tool: "mcp__other__search" })).toBe(false);
  });

  it("matches shell command prefixes but never wrapped or structured commands", () => {
    expect(matchesHeadlessAllowlist(entries, { tool: "Shell", command: "npm test -- --watch" })).toBe(true);
    expect(matchesHeadlessAllowlist(entries, { tool: "Shell", command: "npm run build" })).toBe(false);
    // Structured argv and shell wrappers stay outside the allowlist.
    expect(matchesHeadlessAllowlist(entries, { tool: "Shell", command: "npm test", args: ["npm", "test"] })).toBe(false);
    expect(matchesHeadlessAllowlist(entries, { tool: "Shell", command: "bash -c 'npm test'" })).toBe(false);
  });

  it("ignores malformed patterns", () => {
    expect(matchesHeadlessAllowlist(entries, { tool: "Broken(" })).toBe(false);
    expect(entries.every((entry) => entry.tool !== "Shell" || entry.command !== undefined)).toBe(true);
  });
});
