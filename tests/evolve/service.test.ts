import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createEvolveService, type EvolveService } from "../../src/evolve/service.js";
import { HookBus } from "../../src/hooks/bus.js";
import { scaffoldFixPlugin } from "../../src/evolve/loader.js";
import { EvolveVerificationStore, hashFixPlugin } from "../../src/evolve/verification.js";
import type { PluginHost } from "../../src/plugins/host.js";

interface Fixture {
  workspace: string;
  hooks: HookBus;
  service: EvolveService;
  notices: string[];
}

async function fixture(config: Record<string, unknown> = {}): Promise<Fixture> {
  const workspace = await mkdtemp(join(tmpdir(), "flavor-evolve-service-"));
  const hooks = new HookBus();
  const notices: string[] = [];
  const service = createEvolveService({
    workspace,
    hooks,
    config,
    logger: {
      warn: (message) => { notices.push(`warn: ${message}`); },
      notice: (message) => { notices.push(message); },
    },
  });
  return { workspace, hooks, service, notices };
}

/** Fire the exact event the host emits after a failed tool call. */
async function failTool(hooks: HookBus, tool: string, code: string, message: string, input: unknown = {}) {
  await hooks.emit({
    version: 1,
    type: "PostToolUseFailure",
    payload: { tool, input, agent: "main", error: { code, message } },
  });
}

async function runTool(hooks: HookBus, tool: string, input: unknown = {}, output?: unknown) {
  await hooks.emit({
    version: 1, type: "PostToolUse", payload: { tool, input, agent: "main", ...(output === undefined ? {} : { output }) },
  });
}

async function modelCall(hooks: HookBus) {
  await hooks.emit({
    version: 1,
    type: "AfterModelCall",
    payload: { modelId: "test", iteration: 1, messageCount: 2, attempt: 1, maxAttempts: 3 },
  });
}

async function implementFixHook(workspace: string, name: string): Promise<void> {
  const dir = join(workspace, ".flavor", "plugins", name);
  const manifestPath = join(dir, "flavor-plugin.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { contributes: { hooks: { name: string }[] } };
  manifest.contributes.hooks = [{ name: "PostToolUseFailure" }];
  await writeFile(manifestPath, JSON.stringify(manifest));
  await writeFile(join(dir, "index.js"),
    "export function activate(ctx) { ctx.registerHook('PostToolUseFailure', () => ({ decision: 'allow' })); }\n");
}

describe("CAPTURE", () => {
  it("records failing tool results with key names only and dedupes", async () => {
    const { hooks, service } = await fixture();
    await failTool(hooks, "Read", "ENOENT", "no such file \"C:\\secrets\\a.txt\"", { path: "C:\\secrets\\a.txt" });
    await failTool(hooks, "Read", "ENOENT", "no such file \"C:\\secrets\\b.txt\"", { path: "C:\\secrets\\b.txt" });

    const signals = await service.store.signals();
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({ tool: "Read", errorCode: "ENOENT", count: 2, args: ["path"] });
    expect(signals[0]?.error).not.toContain("secrets");
    expect(signals[0]?.error).toBe('no such file "…"');
  });

  it("stops capturing after dispose", async () => {
    const { hooks, service } = await fixture();
    service.dispose();
    await failTool(hooks, "Read", "ENOENT", "x");
    expect(await service.store.signals()).toEqual([]);
  });
});

describe("CAPTURE (shell side-channel)", () => {
  it("captures Shell exit-code failures from PostToolUse output", async () => {
    const { hooks, service } = await fixture();
    await runTool(hooks, "Shell", { command: "nonexistent-cmd-123", args: [] }, {
      exitCode: 1,
      signal: null,
      stdout: "",
      stderr: "'nonexistent-cmd-123' is not recognized as an internal or external command",
      truncated: false,
    });
    const signals = await service.store.signals();
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({
      tool: "Shell",
      errorCode: "shell_exit_1",
      count: 1,
      args: ["command", "args"],
    });
    expect(signals[0]?.error).toContain("not recognized");
  });

  it("does not capture zero-exit or cancelled Shell results", async () => {
    const { hooks, service } = await fixture();
    await runTool(hooks, "Shell", { command: "echo ok", args: [] }, { exitCode: 0, signal: null, stdout: "ok", stderr: "", truncated: false });
    await runTool(hooks, "Shell", { command: "sleep 5", args: [] }, { exitCode: 2, signal: null, stdout: "", stderr: "killed", truncated: false, terminationReason: "cancelled" });
    await runTool(hooks, "Shell", { command: "npm run dev", args: [] }, { exitCode: null, signal: null, stdout: "", stderr: "", truncated: false });
    expect(await service.store.signals()).toEqual([]);
  });

  it("captures Shell timeouts as failures", async () => {
    const { hooks, service } = await fixture();
    await runTool(hooks, "Shell", { command: "npm test", args: [] }, {
      exitCode: null, signal: null, stdout: "", stderr: "killed: exceeded 100ms", truncated: false, terminationReason: "timeout",
    });
    const signals = await service.store.signals();
    expect(signals[0]).toMatchObject({ tool: "Shell", errorCode: "shell_exit_timeout", count: 1 });
  });

  it("prefers structured Shell diagnostics when raw streams are empty", async () => {
    const { hooks, service } = await fixture();
    await runTool(hooks, "Shell", { command: "missing-tool", args: [] }, {
      exitCode: 127, signal: null, stdout: "", stderr: "", truncated: false,
      diagnostic: {
        kind: "command-not-found",
        message: 'Executable "missing-tool" was not found by the selected runtime shell.',
      },
    });

    const signal = (await service.store.signals())[0];
    expect(signal).toMatchObject({ errorCode: "shell_command-not-found" });
    expect(signal?.error).toContain("was not found by the selected runtime shell");
  });

  it("counts Shell failures toward the repeat threshold and notifies", async () => {
    const { hooks, service, notices } = await fixture();
    const output = {
      exitCode: 1, signal: null, stdout: "", stderr: "boom", truncated: false,
    };
    await runTool(hooks, "Shell", { command: "x", args: [] }, output);
    expect(notices).toEqual([]);
    await runTool(hooks, "Shell", { command: "x", args: [] }, output);
    expect(notices.filter((notice) => notice.includes("/evolve suggest"))).toHaveLength(1);
    expect(await service.store.openSuggestions({ threshold: 2, limit: 10 })).toHaveLength(1);
  });

  it("does not double-count a failure that already went through PostToolUseFailure", async () => {
    const { hooks, service } = await fixture();
    // A real tool failure emits PostToolUseFailure; Shell exit-code failures
    // emit PostToolUse with a non-zero exitCode. The same call never does both.
    await failTool(hooks, "Read", "ENOENT", "missing");
    await runTool(hooks, "Shell", { command: "x", args: [] }, { exitCode: 2, signal: null, stdout: "", stderr: "bad", truncated: false });
    const signals = await service.store.signals();
    expect(signals).toHaveLength(2);
    expect(signals.map((signal) => signal.tool)).toEqual(["Shell", "Read"]);
  });
});

describe("ASSESS", () => {
  it("injects no section below the repeat threshold", async () => {
    const { hooks, service } = await fixture({ minRepeats: 3 });
    await failTool(hooks, "Read", "ENOENT", "missing");
    await failTool(hooks, "Read", "ENOENT", "missing");
    expect(service.promptSection()).toBeUndefined();
  });

  it("injects a bounded suggestion list once the threshold is met", async () => {
    const { hooks, service } = await fixture({ minRepeats: 2, promptTop: 3 });
    await failTool(hooks, "Read", "ENOENT", "missing");
    expect(service.promptSection()).toBeUndefined();
    await failTool(hooks, "Read", "ENOENT", "missing");

    const section = service.promptSection();
    expect(section).toContain("# self-improvement suggestions");
    expect(section).toContain("Read");
    expect(section).toContain("2x");

    // A third distinct failure stays below threshold, so only one suggestion.
    await failTool(hooks, "Glob", "EACCES", "denied");
    const again = service.promptSection();
    expect(again?.match(/- \[[0-9a-f]{12}\]/gu)).toHaveLength(1);
  });

  it("caps the injected list at promptTop", async () => {
    const { hooks, service } = await fixture({ minRepeats: 1, promptTop: 3 });
    for (const tool of ["A", "B", "C", "D"]) await failTool(hooks, tool, "E", "boom");
    const section = service.promptSection();
    expect(section?.match(/- \[[0-9a-f]{12}\]/gu)).toHaveLength(3);
  });
});

describe("REPEAT (beginRun/endRun)", () => {
  it("records run stats, computes signalDelta, and emits LoopEnd", async () => {
    const { hooks, service } = await fixture();
    const loopEvents: Array<Record<string, unknown>> = [];
    await hooks.on("LoopEnd", (event) => {
      loopEvents.push({ ...(event.payload as Record<string, unknown>) });
      return { decision: "allow" as const };
    });

    service.beginRun();
    await modelCall(hooks);
    await modelCall(hooks);
    await modelCall(hooks);
    await runTool(hooks, "Glob");
    await runTool(hooks, "Read");
    await failTool(hooks, "Read", "ENOENT", "missing");
    await failTool(hooks, "Read", "ENOENT", "missing");
    await service.endRun("finished");

    service.beginRun();
    await modelCall(hooks);
    await failTool(hooks, "Glob", "EACCES", "denied");
    await service.endRun("error");

    const reflections = await service.store.reflections(5);
    expect(reflections).toHaveLength(2);
    expect(reflections[1]).toMatchObject({
      iterations: 3, toolCalls: 4, toolErrors: 2, reason: "finished",
      totalFailures: 2, signalDelta: 0, failedTools: ["Read"],
    });
    // Second run: totalFailures grows to 3, delta +1 (regression).
    expect(reflections[0]).toMatchObject({ iterations: 1, reason: "error", totalFailures: 3, signalDelta: 1 });
    // Failures are normalized by calls. A tool not invoked in a run has no
    // trend and cannot be credited as improved.
    expect(reflections[1]!.perTool).toEqual({ Glob: { calls: 1, failures: 0, delta: 0 }, Read: { calls: 3, failures: 2, delta: 0 } });
    expect(reflections[0]!.perTool).toEqual({ Glob: { calls: 1, failures: 1, delta: 100 } });

    expect(loopEvents).toHaveLength(2);
    expect(loopEvents[0]).toMatchObject({ status: "finished", iterations: 3, toolCalls: 4, toolErrors: 2 });
    expect(loopEvents[1]).toMatchObject({ status: "error" });
  });

  it("does not verify a suggestion when a later run never calls its tool", async () => {
    const { hooks, service } = await fixture();

    // Run 1: Read fails twice (>= minRepeats) → open suggestion.
    service.beginRun();
    await failTool(hooks, "Read", "ENOENT", "missing");
    await failTool(hooks, "Read", "ENOENT", "missing");
    await service.endRun("finished");
    const [suggestion] = await service.store.openSuggestions({ threshold: 2, limit: 10 });
    expect(suggestion?.tool).toBe("Read");
    expect(await service.store.verifiedIds()).toEqual([]);

    // Run 2 never invokes Read. This is no evidence of a fix.
    service.beginRun();
    await service.endRun("finished");
    expect(await service.store.verifiedIds()).toEqual([]);
    expect((await service.store.openSuggestions({ threshold: 2, limit: 10 })).map((item) => item.id)).toEqual([suggestion!.id]);
    expect((await service.store.reflections(1))[0]?.perTool).toEqual({});

    // Calling Read again starts a new comparison baseline.
    service.beginRun();
    await failTool(hooks, "Read", "ENOENT", "missing");
    await failTool(hooks, "Read", "ENOENT", "missing");
    const reopened = await service.handleCommand(["suggest"]);
    expect(reopened).toContain("Read");
    await service.endRun("finished");
    expect((await service.store.reflections(1))[0]?.perTool).toEqual({ Read: { calls: 2, failures: 2, delta: 0 } });
    expect(await service.store.verifiedIds()).toEqual([]);
  });

  it("orders suggestions by worsening trend and annotates deltas in suggest", async () => {
    const { hooks, service } = await fixture();

    // Run 1: Glob fails 3x, Read fails 2x → both open, no trends yet.
    service.beginRun();
    await failTool(hooks, "Glob", "EACCES", "denied");
    await failTool(hooks, "Glob", "EACCES", "denied");
    await failTool(hooks, "Glob", "EACCES", "denied");
    await failTool(hooks, "Read", "ENOENT", "missing");
    await failTool(hooks, "Read", "ENOENT", "missing");
    await runTool(hooks, "Glob");
    await runTool(hooks, "Glob");
    await runTool(hooks, "Glob");
    await service.endRun("finished");

    // Run 2 (in progress): Read fails 1x (delta -1, improving), Glob fails 4x
    // (delta +1, worsening). Queries while the run is live reflect live trends.
    service.beginRun();
    await failTool(hooks, "Glob", "EACCES", "denied");
    await failTool(hooks, "Glob", "EACCES", "denied");
    await failTool(hooks, "Glob", "EACCES", "denied");
    await failTool(hooks, "Glob", "EACCES", "denied");
    await failTool(hooks, "Read", "ENOENT", "missing");
    await runTool(hooks, "Read");

    const suggestions = await service.suggestions();
    expect(suggestions.map((suggestion) => [suggestion.tool, suggestion.trend, suggestion.delta])).toEqual([
      ["Glob", "worsening", 50],
      ["Read", "improving", -50],
    ]);
    const output = await service.handleCommand(["suggest"]);
    expect(output).toContain("Glob");
    expect(output).toContain("higher observed failure rate");
    expect(output).toContain("+50");
    expect(output).toContain("Read");
    expect(output).toContain("lower observed failure rate");

    // A lower rate is useful diagnostic data, not proof of a particular fix.
    await service.endRun("finished");
    expect(await service.store.verifiedIds()).toEqual([]);
  });

  it("labels old verified markers as historical, without trusting them", async () => {
    const { hooks, service } = await fixture();
    service.beginRun();
    await failTool(hooks, "Read", "ENOENT", "missing");
    await failTool(hooks, "Read", "ENOENT", "missing");
    await service.endRun("finished");
    const [suggestion] = await service.store.openSuggestions({ threshold: 2 });
    await service.store.markSuggestionVerified(suggestion!.id);

    const output = await service.handleCommand(["verified"]);
    expect(output).toContain("Read");
    expect(output).toContain("legacy marker");
    expect((await service.suggestions()).map((item) => item.id)).toContain(suggestion!.id);
  });

  it("renders a cross-run trends dashboard", async () => {
    const { hooks, service } = await fixture();
    expect(await service.handleCommand(["trends"])).toContain("no reflections recorded yet");

    service.beginRun();
    await failTool(hooks, "Read", "ENOENT", "missing");
    await failTool(hooks, "Read", "ENOENT", "missing");
    await service.endRun("finished");
    service.beginRun();
    await service.endRun("finished");

    const output = await service.handleCommand(["trends"]);
    expect(output).toContain("evolve trends (last 2 run(s), newest first)");
    expect(output).not.toContain("Read: 0 failure(s) this run");
    expect(await service.handleCommand(["trends", "1"])).toContain("last 1 run(s)");
  });
});

describe("GUARDRAILS (prompt rules)", () => {
  it("lets an explicit rule add activate an identical pending proposal", async () => {
    const { service } = await fixture();
    const { rule } = await service.store.addRule({ text: "Check the binary first", status: "proposed" });
    await service.initialize();
    expect(service.promptSection()).toBeUndefined();
    expect(await service.handleCommand(["rule", "add", "Check the binary first"])).toContain("activated existing guardrail");
    expect((await service.store.listRules())[0]).toMatchObject({ id: rule.id, status: "active" });
    expect(service.promptSection()).toContain("Check the binary first");
  });

  it("adds, lists, and removes rules and injects them into the prompt section", async () => {
    const { service } = await fixture();
    expect(await service.handleCommand(["rule"])).toContain("no guardrail rules yet");
    expect(service.promptSection()).toBeUndefined();

    const added = await service.handleCommand(["rule", "add", "Always stage files before committing"]);
    expect(added).toContain("added guardrail");
    const section = service.promptSection();
    expect(section).toContain("# learned guardrails (evolve)");
    expect(section).toContain("Always stage files before committing");

    // Duplicate add dedupes instead of stacking.
    expect(await service.handleCommand(["rule", "add", "Always stage files before committing"]))
      .toContain("already exists");
    expect(await service.store.listRules()).toHaveLength(1);

    expect(await service.handleCommand(["rule", "list"])).toContain("Always stage files before committing");
    const id = (await service.store.listRules())[0]!.id;
    expect(await service.handleCommand(["rule", "remove", id])).toContain("removed guardrail");
    expect(await service.handleCommand(["rule", "remove", id])).toContain(`no guardrail with id "${id}"`);
    expect(service.promptSection()).toBeUndefined();
  });

  it("combines guardrails and suggestions in one prompt section", async () => {
    const { hooks, service } = await fixture();
    await service.handleCommand(["rule", "add", "Prefer staged commits"]);
    await failTool(hooks, "Read", "ENOENT", "missing");
    await failTool(hooks, "Read", "ENOENT", "missing");

    const section = service.promptSection();
    expect(section).toContain("# learned guardrails (evolve)");
    expect(section).toContain("# self-improvement suggestions (evolve)");
    expect(section!.indexOf("guardrails")).toBeLessThan(section!.indexOf("suggestions"));
  });
});

describe("COMMANDS", () => {
  it("lists signals and suggestions", async () => {
    const { hooks, service } = await fixture();
    await failTool(hooks, "Read", "ENOENT", "missing");
    expect(await service.handleCommand(["signals"])).toContain("Read");

    await failTool(hooks, "Read", "ENOENT", "missing");
    const suggest = await service.handleCommand(["suggest"]);
    expect(suggest).toContain("Read");
    expect(suggest).toContain("2x");
  });

  it("scaffolds a plugin for improve and writes PLAN.md without marking done", async () => {
    const { hooks, service, workspace } = await fixture();
    await failTool(hooks, "Read", "ENOENT", "missing");
    await failTool(hooks, "Read", "ENOENT", "missing");
    const [suggestion] = await service.store.openSuggestions({ threshold: 2, limit: 10 });

    const output = await service.handleCommand(["improve", suggestion!.id]);
    expect(output).toContain("fix-read");
    const dir = join(workspace, ".flavor", "plugins", "fix-read");
    expect(await stat(join(dir, "flavor-plugin.json"))).toBeDefined();
    const plan = await readFile(join(dir, "PLAN.md"), "utf8");
    expect(plan).toContain("missing");

    // The suggestion is still open until the human marks it done.
    const [stillOpen] = await service.store.openSuggestions({ threshold: 2, limit: 10 });
    expect(stillOpen?.id).toBe(suggestion!.id);
  });

  it("rejects an empty scaffold, then verifies a registered fix in the sandbox", async () => {
    const { hooks, service, workspace } = await fixture();
    await failTool(hooks, "Read", "ENOENT", "missing");
    await failTool(hooks, "Read", "ENOENT", "missing");
    const [suggestion] = await service.store.openSuggestions({ threshold: 2, limit: 10 });
    await service.handleCommand(["improve", suggestion!.id]);

    expect(await service.handleCommand(["verify", "fix-read"])).toContain("registered no tools");
    await implementFixHook(workspace, "fix-read");
    const output = await service.handleCommand(["verify", "fix-read"]);
    expect(output).toContain("verify OK: fix-read");
    // improve saved a draft snapshot; verification alone does not activate it.
    expect(await stat(join(workspace, ".flavor", "plugins", ".versions", "fix-read"))).toBeDefined();
  });

  it("blocks reload until the exact bytes pass verification and tests", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "flavor-evolve-gate-"));
    await scaffoldFixPlugin(workspace, "fix-read");
    await implementFixHook(workspace, "fix-read");
    let reloads = 0;
    const pluginHost = { reload: async () => { reloads++; return { ok: true }; }, unload: async () => {} } as unknown as PluginHost;
    const service = createEvolveService({ workspace, hooks: new HookBus(), pluginHost, config: { testCommand: "echo ok" } });
    const ledger = new EvolveVerificationStore(workspace);
    const original = await hashFixPlugin(workspace, "fix-read");

    expect(await service.handleCommand(["reload", "fix-read"])).toContain("reload BLOCKED");
    expect(reloads).toBe(0);
    expect(await service.handleCommand(["verify", "fix-read"])).toContain("verify OK");
    expect(await service.handleCommand(["reload", "fix-read"])).toContain("reload BLOCKED");
    expect(await service.handleCommand(["test"])).toContain("tests passed");
    expect(await service.handleCommand(["reload", "fix-read"])).toContain("reloaded fix-read");
    expect(reloads).toBe(1);
    expect((await ledger.list())["fix-read"]?.activeDigest).toBe(original);

    const entry = join(workspace, ".flavor", "plugins", "fix-read", "index.js");
    await writeFile(entry, `${await readFile(entry, "utf8")}\n// edited after tests\n`);
    expect(await service.handleCommand(["reload", "fix-read"])).toContain("reload BLOCKED");
    expect(reloads).toBe(1);
    const snapshot = await ledger.goodSnapshot("fix-read");
    expect(snapshot).toBeDefined();
    const snapEntry = join(snapshot!, "index.js");
    await writeFile(snapEntry, `${await readFile(snapEntry, "utf8")}\n// changed snapshot\n`);
    expect(await service.handleCommand(["revert", "fix-read"])).toContain("no longer matches its approved version");
    service.dispose();
  });

  it("reports a failed reload during revert instead of claiming restoration", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "flavor-evolve-revert-"));
    await scaffoldFixPlugin(workspace, "fix-read");
    await implementFixHook(workspace, "fix-read");
    let failReload = false;
    const pluginHost = { reload: async () => failReload
      ? { ok: false, error: "activation failed" } : { ok: true }, unload: async () => {} } as unknown as PluginHost;
    const service = createEvolveService({ workspace, hooks: new HookBus(), pluginHost, config: { testCommand: "echo ok" } });
    expect(await service.handleCommand(["verify", "fix-read"])).toContain("verify OK");
    expect(await service.handleCommand(["test"])).toContain("tests passed");
    expect(await service.handleCommand(["reload", "fix-read"])).toContain("reloaded fix-read");
    failReload = true;
    expect(await service.handleCommand(["revert", "fix-read"])).toContain("revert FAILED: fix-read\n  activation failed");
    service.dispose();
  });

  it("verifies a missing plugin reports failure", async () => {
    const { service } = await fixture();
    expect(await service.handleCommand(["verify", "fix-missing"])).toContain("verify FAILED");
  });

  it("marks suggestions done and clears signals", async () => {
    const { hooks, service } = await fixture();
    await failTool(hooks, "Read", "ENOENT", "missing");
    await failTool(hooks, "Read", "ENOENT", "missing");
    const [suggestion] = await service.store.openSuggestions({ threshold: 2, limit: 10 });

    await service.handleCommand(["done", suggestion!.id]);
    expect(await service.handleCommand(["suggest"])).toContain("no open suggestions");

    await service.handleCommand(["clear"]);
    expect(await service.handleCommand(["signals"])).toBe("no signals recorded yet");
  });

  it("runs the configured test command", async () => {
    const { service } = await fixture({ testCommand: "echo ok", testTimeoutMs: 10_000 });
    const output = await service.handleCommand(["test"]);
    expect(output).toContain("tests passed (exit 0)");
  });

  it("returns a status overview for empty arguments", async () => {
    const { service } = await fixture();
    const overview = await service.handleCommand([]);
    expect(overview).toContain("evolve status");
    expect(overview).toContain("open suggestions");
    expect(overview).toContain("latest signals");
    expect(overview).toContain("usage: /evolve");
    expect(await service.handleCommand(["nonsense"])).toContain("usage: /evolve");
  });
});

describe("NOTIFY (user-facing signals)", () => {
  it("notifies exactly once when a signal first reaches the repeat threshold", async () => {
    const { hooks, service, notices } = await fixture();
    await failTool(hooks, "Read", "ENOENT", "missing");
    expect(notices).toEqual([]);
    await failTool(hooks, "Read", "ENOENT", "missing");
    const suggestionNotices = notices.filter((notice) => notice.includes("/evolve suggest"));
    expect(suggestionNotices).toHaveLength(1);
    expect(suggestionNotices[0]).toContain("Read");
    // A third failure (count 3) does not re-notify.
    await failTool(hooks, "Read", "ENOENT", "missing");
    expect(notices.filter((notice) => notice.includes("/evolve suggest"))).toHaveLength(1);
  });

  it("notifies a quiet one-line summary when a run has no errors", async () => {
    const { service, notices } = await fixture();
    service.beginRun();
    await service.endRun("finished");
    const summaries = notices.filter((notice) => notice.includes("run finished"));
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toContain("no tool errors");
    expect(summaries[0]!.split("\n")).toHaveLength(1);
  });

  it("does not claim improvement after a run without relevant calls", async () => {
    const { hooks, service, notices } = await fixture();
    service.beginRun();
    await failTool(hooks, "Read", "ENOENT", "missing");
    await failTool(hooks, "Read", "ENOENT", "missing");
    await service.endRun("finished");

    service.beginRun();
    await service.endRun("finished");

    const summary = notices.filter((notice) => notice.includes("run finished")).at(-1)!;
    expect(summary).toContain("no tool errors");
    expect(await service.store.verifiedIds()).toEqual([]);
  });

  it("reports an increased failure rate when both runs invoked the tool", async () => {
    const { hooks, service, notices } = await fixture();
    service.beginRun();
    await failTool(hooks, "Read", "ENOENT", "missing");
    await failTool(hooks, "Read", "ENOENT", "missing");
    await runTool(hooks, "Read");
    await runTool(hooks, "Read");
    await service.endRun("finished");
    service.beginRun();
    await failTool(hooks, "Read", "ENOENT", "missing");
    await failTool(hooks, "Read", "ENOENT", "missing");
    await service.endRun("finished");

    const summary = notices.filter((notice) => notice.includes("run finished")).at(-1)!;
    expect(summary).toContain("higher failure rate");
    expect(summary).toContain("+50 percentage points");
    expect(await service.store.verifiedIds()).toEqual([]);
  });
});

describe("evolve_improve TOOL", () => {
  it("scaffolds a plugin for an open suggestion", async () => {
    const { hooks, service, workspace } = await fixture();
    await failTool(hooks, "Shell", "tool_error", "command failed");
    await failTool(hooks, "Shell", "tool_error", "command failed");
    const [suggestion] = await service.store.openSuggestions({ threshold: 2, limit: 10 });

    const tool = service.toolDefinition();
    const output = await tool.execute({ suggestionId: suggestion!.id, implementation: "wrap the shell tool" }, new AbortController().signal);

    expect(String(output)).toContain("fix-shell");
    expect(String(output)).toContain("/evolve verify fix-shell");
    const plan = await readFile(join(workspace, ".flavor", "plugins", "fix-shell", "PLAN.md"), "utf8");
    expect(plan).toContain("wrap the shell tool");
  });

  it("throws for an unknown suggestion id", async () => {
    const { service } = await fixture();
    const tool = service.toolDefinition();
    await expect(
      tool.execute({ suggestionId: "deadbeef", implementation: "x" }, new AbortController().signal),
    ).rejects.toThrow(/no open suggestion/i);
  });

  it("holds a model-proposed guardrail until it is accepted", async () => {
    const { hooks, service } = await fixture();
    await failTool(hooks, "Shell", "tool_error", "command failed");
    await failTool(hooks, "Shell", "tool_error", "command failed");
    const [suggestion] = await service.store.openSuggestions({ threshold: 2, limit: 10 });

    const tool = service.toolDefinition();
    const output = String(await tool.execute({
      suggestionId: suggestion!.id,
      implementation: "Check that the binary exists before invoking it",
      kind: "prompt_rule",
    }, new AbortController().signal));

    expect(output).toContain("Proposed guardrail rule");
    expect(output).toContain("stays open");
    expect((await service.store.openSuggestions({ threshold: 2, limit: 10 }))[0]?.id).toBe(suggestion!.id);
    const rules = await service.store.listRules();
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({
      text: "Check that the binary exists before invoking it", sourceId: suggestion!.id, status: "proposed",
    });
    expect(service.promptSection()).not.toContain("Check that the binary exists before invoking it");
    expect(await service.handleCommand(["rule", "accept", rules[0]!.id])).toContain("activated guardrail");
    expect(service.promptSection()).toContain("Check that the binary exists before invoking it");
  });
});
