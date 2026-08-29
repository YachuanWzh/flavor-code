#!/usr/bin/env node

/**
 * Production-path memory soak for the long-session heap-OOM regression.
 *
 * This intentionally does not run inside Vitest. It starts the built CLI via
 * its launcher, speaks the public RPC protocol over stdio, and serves real
 * Anthropic-compatible HTTP/SSE responses from a loopback server. That covers
 * the provider SDK, agent loop, Task/subagent state changes, context compaction,
 * session persistence, launcher flags, and a separate V8 heap.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createInterface } from "node:readline";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const CLI = join(ROOT, "dist", "cli.js");
const CRASH_SESSION_ID = "session-20260828155654859-1591978c";
const DEFAULT_CRASH_SESSION = resolve(ROOT, "..", "flavor-plugins", ".flavor", "sessions", `${CRASH_SESSION_ID}.jsonl`);
const DEFAULT_CRASH_TREE = resolve(ROOT, "..", "flavor-plugins", ".flavor", "session-trees", CRASH_SESSION_ID, "tree.json");
const ROUNDS = positiveInteger(process.env.FLAVOR_STRESS_ROUNDS, 240);
const HEAP_MB = positiveInteger(process.env.FLAVOR_STRESS_HEAP_MB, 384);
const PAYLOAD_BYTES = positiveInteger(process.env.FLAVOR_STRESS_PAYLOAD_BYTES, 8_192);
const MANUAL_CHECKPOINTS = positiveInteger(process.env.FLAVOR_STRESS_MANUAL_CHECKPOINTS, 120);
const KEEP_TEMP = process.env.FLAVOR_STRESS_KEEP_TEMP === "1";

async function main() {
  if (!existsSync(CLI)) throw new Error(`Built CLI not found at ${CLI}; run npm run build:cli first`);
  const root = await mkdtemp(join(tmpdir(), "flavor-production-memory-stress-"));
  const probePath = join(root, "heap-probe.cjs");
  await writeFile(probePath, heapProbeSource(), "utf8");

  const gateway = new StressGateway();
  await gateway.start();
  const startedAt = Date.now();
  try {
    const exact = await runExactTaskStateRegression(root, probePath, gateway);
    const soak = await runFreshSoak(root, probePath, gateway, ROUNDS);
    const report = {
      version: "1.3.17",
      durationMs: Date.now() - startedAt,
      heapLimitMb: HEAP_MB,
      payloadBytes: PAYLOAD_BYTES,
      exact,
      soak,
      gateway: gateway.snapshot(),
    };
    const reportPath = process.env.FLAVOR_STRESS_REPORT?.trim();
    if (reportPath) {
      await mkdir(dirname(resolve(reportPath)), { recursive: true });
      await writeFile(resolve(reportPath), `${JSON.stringify(report, null, 2)}\n`, "utf8");
    }
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally {
    await gateway.close();
    if (!KEEP_TEMP) await rm(root, { recursive: true, force: true });
    else process.stderr.write(`stress: retained ${root}\n`);
  }
}

async function runExactTaskStateRegression(tempRoot, probe, server) {
  const fixture = process.env.FLAVOR_STRESS_CRASH_SESSION?.trim() || DEFAULT_CRASH_SESSION;
  const workspace = join(tempRoot, "exact-root-regression");
  await prepareWorkspace(workspace, server.baseURL, { contextWindow: 200_000 });
  let resumedRealCrashSession = false;
  let resumeSession;
  if (existsSync(fixture)) {
    await mkdir(join(workspace, ".flavor", "sessions"), { recursive: true });
    await copyCrashSessionIsolated(fixture, join(workspace, ".flavor", "sessions", basename(fixture)), workspace);
    const treeFixture = process.env.FLAVOR_STRESS_CRASH_TREE?.trim()
      || (fixture === DEFAULT_CRASH_SESSION
        ? DEFAULT_CRASH_TREE
        : resolve(dirname(fixture), "..", "session-trees", CRASH_SESSION_ID, "tree.json"));
    if (existsSync(treeFixture)) {
      const treeDestination = join(workspace, ".flavor", "session-trees", CRASH_SESSION_ID, "tree.json");
      await mkdir(dirname(treeDestination), { recursive: true });
      await copyFile(treeFixture, treeDestination);
    }
    resumedRealCrashSession = true;
    resumeSession = CRASH_SESSION_ID;
  }

  const scenario = server.beginScenario({ name: "exact-task-state", forceTaskAt: 9, baseUsage: 80_000 });
  const cli = await RpcCli.start({ workspace, probe, heapMb: HEAP_MB, resumeSession });
  try {
    const initial = await cli.state();
    for (let index = 1; index <= MANUAL_CHECKPOINTS; index += 1) {
      await cli.checkpoint(`manual pressure checkpoint ${index}/${MANUAL_CHECKPOINTS}`);
      if (index % 25 === 0) process.stderr.write(`stress: manual checkpoints=${index}/${MANUAL_CHECKPOINTS}\n`);
    }
    for (let round = 1; round <= 8; round += 1) {
      await cli.prompt(`Prime historical turn ${round}.\n${deterministicPayload(round, 8_192)}`);
      await cli.waitIdle();
    }
    await cli.prompt("Run the isolated task-state pressure regression and return a short result.");
    await cli.waitIdle();

    const stats = server.scenario(scenario);
    assert.equal(stats.taskCalls, 1, "exact scenario did not execute the real Task tool path");
    assert.ok(stats.subagentRequests >= 1,
      `exact scenario did not execute a real subagent model request; tools=${stats.observedToolSets.join(" | ")}; events=${JSON.stringify(cli.eventCounts)}; toolEnds=${JSON.stringify(cli.toolEnds)}`);
    assert.ok(stats.summaryRequests >= 1,
      "provider reported 162K tokens, but task-state churn erased the pressure and no compaction occurred");
    assert.ok(stats.taskToSummaryOrdering,
      "compaction did not occur after Task changed dynamic state and before the next main-model request");
    assert.ok(cli.compactedEvents >= 1, "production runtime did not emit a compacted event");
    cli.assertHealthy();

    await cli.forceFullGc();
    const memory = await cli.memorySummary();
    assert.ok(memory.peakHeapRatio < 0.8,
      `exact scenario crossed the 80% heap guard (${percent(memory.peakHeapRatio)})`);
    const tree = await treeSummary(workspace, initial.sessionId);
    assert.equal(tree.exists, true, "isolated crash rewind tree was not loaded");
    assert.ok(tree.nodes <= 100, `resumed rewind history did not converge (${tree.nodes} nodes)`);
    assert.ok(tree.contextChars <= 2_000_000,
      `resumed rewind contexts did not converge (${tree.contextChars} chars)`);
    return {
      resumedRealCrashSession,
      fixture: resumedRealCrashSession ? fixture : null,
      sessionId: initial.sessionId,
      manualCheckpoints: MANUAL_CHECKPOINTS,
      taskCalls: stats.taskCalls,
      subagentRequests: stats.subagentRequests,
      summaryRequests: stats.summaryRequests,
      compactedEvents: cli.compactedEvents,
      requestMessagesBeforeSummary: stats.requestMessagesBeforeFirstSummary,
      requestMessagesAfterSummary: stats.requestMessagesAfterFirstSummary,
      tree,
      memory,
    };
  } finally {
    await cli.close();
  }
}

async function runFreshSoak(tempRoot, probe, server, rounds) {
  const workspace = join(tempRoot, "fresh-soak");
  await prepareWorkspace(workspace, server.baseURL, { contextWindow: 200_000 });
  await writeFile(join(workspace, "large-tool-output.txt"), `${"tool-output-line-".repeat(64)}\n`.repeat(800), "utf8");
  const scenario = server.beginScenario({ name: "fresh-soak", taskEvery: 30, readEvery: 7, highUsage: false });
  const cli = await RpcCli.start({ workspace, probe, heapMb: HEAP_MB });
  try {
    const initial = await cli.state();
    for (let round = 1; round <= rounds; round += 1) {
      const payload = deterministicPayload(round, PAYLOAD_BYTES);
      await cli.prompt(`Stress round ${round}/${rounds}. Keep the answer short.\n${payload}`);
      await cli.waitIdle();
      if (round % 25 === 0) {
        const memory = await cli.memorySummary();
        process.stderr.write(
          `stress: round=${round}/${rounds} compactions=${cli.compactedEvents} heap=${memory.latestHeapMb.toFixed(1)}MB peak=${memory.peakHeapMb.toFixed(1)}MB\n`,
        );
      }
    }

    const stats = server.scenario(scenario);
    cli.assertHealthy();
    assert.ok(stats.mainRequests >= rounds, "not every soak turn reached the production provider adapter");
    assert.ok(stats.taskCalls >= Math.floor(rounds / 30), "Task/subagent churn was not sustained throughout the soak");
    assert.ok(stats.readCalls >= Math.floor(rounds / 10), "large real tool outputs were not sustained throughout the soak");
    assert.ok(stats.summaryRequests >= Math.floor(rounds / 20), "long-session compaction did not repeatedly fire");
    assert.ok(cli.compactedEvents >= stats.summaryRequests,
      "one or more production compaction transactions did not commit");

    await cli.forceFullGc();
    const memory = await cli.memorySummary();
    assert.ok(memory.peakHeapRatio < 0.8,
      `soak crossed the 80% heap guard (${percent(memory.peakHeapRatio)})`);
    assert.ok(memory.postGcHeapRatio < 0.5,
      `full-GC retained heap is too high (${memory.postGcHeapMb.toFixed(1)}MB, ${percent(memory.postGcHeapRatio)})`);
    assert.ok(stats.maxRequestBytes < 16 * 1024 * 1024,
      `provider request grew unexpectedly large (${stats.maxRequestBytes} bytes)`);

    const session = await sessionSummary(workspace, initial.sessionId);
    assert.ok(session.roleMessageLines < 250,
      `persisted conversation did not converge (${session.roleMessageLines} message records)`);
    assert.ok(session.timelineLines <= 200,
      `presentation timeline did not converge (${session.timelineLines} turns)`);
    assert.equal(session.lastTimelinePrompt, `Stress round ${rounds}/${rounds}. Keep the answer short.\n${deterministicPayload(rounds, PAYLOAD_BYTES)}`,
      "the final soak turn was not persisted; the session may have silently hit its size limit");
    assert.ok(session.bytes < 5 * 1024 * 1024,
      `persisted session reached the 5 MB safety limit (${session.bytes} bytes)`);
    const tree = await treeSummary(workspace, initial.sessionId);
    assert.equal(tree.exists, false,
      "ordinary turns created an automatic rewind tree; checkpoints must be explicit");
    const checkpointsCreated = existsSync(join(workspace, ".flavor", "checkpoints"));
    assert.equal(checkpointsCreated, false,
      "ordinary turns created automatic workspace checkpoints; checkpoints must be explicit");
    return {
      rounds,
      payloadBytes: PAYLOAD_BYTES,
      sessionId: initial.sessionId,
      mainRequests: stats.mainRequests,
      subagentRequests: stats.subagentRequests,
      taskCalls: stats.taskCalls,
      readCalls: stats.readCalls,
      summaryRequests: stats.summaryRequests,
      compactedEvents: cli.compactedEvents,
      maxRequestMessages: stats.maxRequestMessages,
      maxRequestBytes: stats.maxRequestBytes,
      session,
      tree,
      checkpointsCreated,
      memory,
    };
  } finally {
    await cli.close();
  }
}

async function prepareWorkspace(workspace, baseURL, options) {
  await mkdir(join(workspace, ".flavor"), { recursive: true });
  await writeFile(join(workspace, ".flavor", "flavor.json"), `${JSON.stringify({
    providers: {
      pkce: {
        type: "anthropic",
        baseURL,
        apiKey: "\${FLAVOR_STRESS_API_KEY}",
        defaultModel: "qwen3.8-flash",
        cheapModel: "qwen3.8-cheap",
        models: ["qwen3.8-flash", "qwen3.8-cheap", "bootstrap"],
        maxOutputTokens: 2_048,
        thinkingBudget: 0,
      },
    },
    agents: { main: { model: "pkce:qwen3.8-flash" }, subagent: { model: "pkce:qwen3.8-cheap" } },
    maxSubagents: 2,
    maxSessions: 10,
    maxIterations: { main: 80, subagent: 40, softLimitFactor: 0.8, extendBy: 20 },
    context: {
      windowTokens: options.contextWindow,
      reservedOutputTokens: 20_000,
      autoCompactBufferTokens: 27_000,
      warningBufferTokens: 20_000,
      blockingBufferTokens: 3_000,
      microcompactKeepRecentToolResults: 5,
      recentTokens: 10_000,
      recentTextMessages: 5,
      maxRecentTokens: 40_000,
      toolOutputChars: 30_000,
    },
    memory: { enabled: false },
    hallucination: { showWarnings: false, evaluationTimeoutMs: 2_000 },
    permissionMode: "bypassPermissions",
    sleep: false,
  }, null, 2)}\n`, "utf8");
}

async function copyCrashSessionIsolated(source, destination, workspace) {
  const raw = await readFile(source, "utf8");
  const newline = raw.indexOf("\n");
  assert.ok(newline > 0, `crash session fixture is malformed: ${source}`);
  const metadata = JSON.parse(raw.slice(0, newline));
  assert.equal(metadata.sessionId, CRASH_SESSION_ID, `unexpected crash session id in ${source}`);
  metadata.workspace = { ...(metadata.workspace ?? {}), path: workspace };
  metadata.models = { main: "pkce:qwen3.8-flash", subagent: "pkce:qwen3.8-cheap" };
  await writeFile(destination, `${JSON.stringify(metadata)}\n${raw.slice(newline + 1)}`, "utf8");
}

class StressGateway {
  constructor() {
    this.server = createServer(this.handle.bind(this));
    this.scenarios = new Map();
    this.active = undefined;
    this.nextScenario = 1;
  }

  async start() {
    await new Promise((resolvePromise, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, "127.0.0.1", resolvePromise);
    });
    const address = this.server.address();
    this.baseURL = `http://127.0.0.1:${address.port}`;
  }

  beginScenario(options) {
    const id = `scenario-${this.nextScenario++}`;
    this.scenarios.set(id, {
      id,
      options,
      mainRequests: 0,
      logicalTurns: 0,
      subagentRequests: 0,
      summaryRequests: 0,
      taskCalls: 0,
      readCalls: 0,
      sinceSummary: 0,
      maxRequestMessages: 0,
      maxRequestBytes: 0,
      observedToolSets: [],
      requestMessagesBeforeFirstSummary: undefined,
      requestMessagesAfterFirstSummary: undefined,
      waitingForPostTaskSummary: false,
      taskToSummaryOrdering: false,
      afterSummary: false,
    });
    this.active = id;
    return id;
  }

  scenario(id) {
    const value = this.scenarios.get(id);
    assert.ok(value, `missing gateway scenario ${id}`);
    return value;
  }

  snapshot() {
    return [...this.scenarios.values()].map(({ options, ...stats }) => ({ ...stats, name: options.name }));
  }

  async handle(request, response) {
    if (request.method !== "POST" || request.url !== "/v1/messages") {
      response.writeHead(404).end();
      return;
    }
    let raw = "";
    for await (const chunk of request) raw += chunk.toString("utf8");
    const body = JSON.parse(raw);
    const stats = this.scenario(this.active);
    const tools = Array.isArray(body.tools) ? body.tools.map((tool) => tool.name) : [];
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const toolSet = tools.join(",");
    if (!stats.observedToolSets.includes(toolSet)) stats.observedToolSets.push(toolSet);
    stats.maxRequestMessages = Math.max(stats.maxRequestMessages, messages.length);
    stats.maxRequestBytes = Math.max(stats.maxRequestBytes, Buffer.byteLength(raw));

    if (tools.length === 0) {
      stats.summaryRequests += 1;
      stats.sinceSummary = 0;
      stats.requestMessagesBeforeFirstSummary ??= messages.length;
      if (stats.waitingForPostTaskSummary) stats.taskToSummaryOrdering = true;
      stats.waitingForPostTaskSummary = false;
      stats.afterSummary = true;
      sendText(response, compactSummary(), 120_000);
      return;
    }

    if (tools.includes("TaskOutput") && JSON.stringify(messages).includes("Complete task stress-node")) {
      stats.subagentRequests += 1;
      sendText(response, JSON.stringify(subagentResult(messages)), 12_000);
      return;
    }

    stats.mainRequests += 1;
    stats.sinceSummary += 1;
    if (stats.afterSummary) {
      stats.requestMessagesAfterFirstSummary ??= messages.length;
      stats.afterSummary = false;
    }
    const hasToolResult = lastMessageHasToolResult(messages);
    if (hasToolResult) {
      if (stats.waitingForPostTaskSummary) stats.taskToSummaryOrdering = false;
      sendText(response, "ok", inputTokens(stats));
      return;
    }

    stats.logicalTurns += 1;
    const turn = stats.logicalTurns;
    const forceTask = stats.options.forceTaskAt === turn;
    const periodicTask = stats.options.taskEvery && turn > 0 && turn % stats.options.taskEvery === 0;
    if (forceTask || periodicTask) {
      stats.taskCalls += 1;
      stats.waitingForPostTaskSummary = true;
      sendTool(response, "Task", `stress-task-${stats.taskCalls}`, {
        nodes: [{
          id: `stress-node-${stats.taskCalls}`,
          description: "Return a deterministic verification result without changing files",
          dependencies: [],
          expectedOutputs: ["verification result"],
          verification: ["response is valid"],
          files: [],
        }],
      }, 162_047);
      return;
    }
    if (stats.options.readEvery && turn > 0 && turn % stats.options.readEvery === 0) {
      stats.readCalls += 1;
      sendTool(response, "Read", `stress-read-${stats.readCalls}`, {
        path: "large-tool-output.txt",
        maxBytes: 1_048_576,
        force: true,
      }, inputTokens(stats));
      return;
    }
    sendText(response, "ok", inputTokens(stats));
  }

  close() {
    return new Promise((resolvePromise) => this.server.close(() => resolvePromise()));
  }
}

class RpcCli {
  static async start(options) {
    const metrics = join(options.workspace, "heap-metrics.jsonl");
    const args = [CLI, "--mode", "rpc", "--workspace", options.workspace];
    if (options.resumeSession) args.push("--resume", options.resumeSession);
    const existingNodeOptions = process.env.NODE_OPTIONS?.trim();
    const nodeOptions = [existingNodeOptions, `--max-old-space-size=${options.heapMb}`, `--require=${options.probe}`]
      .filter(Boolean).join(" ");
    const child = spawn(process.execPath, args, {
      cwd: options.workspace,
      env: {
        ...process.env,
        HOME: options.workspace,
        USERPROFILE: options.workspace,
        FLAVOR_STRESS_API_KEY: "local-stress-key",
        FLAVOR_STRESS_METRICS: metrics,
        NODE_OPTIONS: nodeOptions,
      },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const rpc = new RpcCli(child, metrics);
    try { await rpc.command("get_state", {}, 120_000); }
    catch (error) {
      throw new Error(`CLI RPC startup failed: ${error instanceof Error ? error.message : String(error)}\n${rpc.stderr.slice(-4_000)}`);
    }
    return rpc;
  }

  constructor(child, metrics) {
    this.child = child;
    this.metrics = metrics;
    this.pending = new Map();
    this.waiters = [];
    this.sequence = 0;
    this.stderr = "";
    this.compactedEvents = 0;
    this.eventCounts = {};
    this.toolEnds = [];
    this.exited = new Promise((resolvePromise) => child.once("exit", (code, signal) => {
      const failure = new Error(`CLI exited before completing RPC work (code=${code}, signal=${signal})`);
      for (const pending of this.pending.values()) pending.reject(failure);
      this.pending.clear();
      for (const waiter of this.waiters) waiter.resolve({ type: "error", error: { code: "process_exit", message: failure.message } });
      this.waiters.length = 0;
      resolvePromise({ code, signal });
    }));
    createInterface({ input: child.stdout, crlfDelay: Infinity }).on("line", (line) => this.onLine(line));
    child.stderr.on("data", (chunk) => { this.stderr += chunk.toString("utf8"); });
  }

  onLine(line) {
    let value;
    try { value = JSON.parse(line); }
    catch { throw new Error(`RPC emitted non-JSON stdout: ${line.slice(0, 500)}`); }
    if (value.type === "response" || (value.type === "error" && value.id)) {
      const pending = this.pending.get(value.id);
      if (pending) {
        this.pending.delete(value.id);
        value.type === "error" ? pending.reject(new Error(value.message)) : pending.resolve(value.data);
      }
    }
    if (value.type === "event") {
      const eventType = value.event?.type ?? "unknown";
      this.eventCounts[eventType] = (this.eventCounts[eventType] ?? 0) + 1;
      if (eventType === "tool-end") this.toolEnds.push({ name: value.event.name, result: value.event.result });
      if (value.event?.type === "compacted") this.compactedEvents += 1;
      for (const waiter of [...this.waiters]) {
        if (!waiter.predicate(value.event)) continue;
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        waiter.resolve(value.event);
      }
    }
  }

  command(type, fields = {}, timeoutMs = 60_000) {
    const id = `stress-${++this.sequence}`;
    const response = withTimeout(new Promise((resolvePromise, reject) => {
      this.pending.set(id, { resolve: resolvePromise, reject });
    }), timeoutMs, `RPC ${type}`);
    this.child.stdin.write(`${JSON.stringify({ id, type, ...fields })}\n`);
    return response;
  }

  event(predicate, timeoutMs = 120_000) {
    return withTimeout(new Promise((resolvePromise) => {
      this.waiters.push({ predicate, resolve: resolvePromise });
    }), timeoutMs, "agent completion");
  }

  async prompt(message) {
    const terminal = this.event((event) => event?.type === "done" || event?.type === "error");
    await this.command("prompt", { message });
    const event = await terminal;
    assert.notEqual(event.type, "error", `agent failed: ${JSON.stringify(event.error)}`);
  }

  state() { return this.command("get_state"); }
  checkpoint(label) { return this.command("checkpoint", { label }, 120_000); }

  async waitIdle() {
    for (let attempt = 0; attempt < 1_000; attempt += 1) {
      const state = await this.state();
      if (!state.active && state.queue.steering.length === 0 && state.queue.followUp.length === 0) return;
      await delay(10);
    }
    throw new Error("RPC session did not become idle");
  }

  assertHealthy() {
    assert.ok(!/heap out of memory|fatal error|allocation failed/i.test(this.stderr),
      `CLI emitted a fatal-memory signature: ${this.stderr.slice(-2_000)}`);
    assert.equal(this.child.exitCode, null, `CLI exited during stress with ${this.child.exitCode}`);
  }

  async memorySummary() {
    let samples = [];
    for (let attempt = 0; attempt < 5 && samples.length < 2; attempt += 1) {
      let raw = "";
      try { raw = await readFile(this.metrics, "utf8"); }
      catch { /* A very fast startup may not have emitted the first sample yet. */ }
      const all = raw.trim().split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line));
      samples = all.filter((sample) => String(sample.argv).includes("cli-main.js"));
      if (samples.length < 2) await delay(100);
    }
    assert.ok(samples.length >= 2, `insufficient separate-process heap samples (${samples.length})`);
    const heapMb = samples.map((sample) => sample.heapUsed / 1_048_576);
    const ratios = samples.map((sample) => sample.heapUsed / sample.heapLimit);
    const span = Math.max(2, Math.floor(heapMb.length / 4));
    const postGc = [...samples].reverse().find((sample) => sample.fullGc === true) ?? samples.at(-1);
    return {
      samples: samples.length,
      processIds: [...new Set(samples.map((sample) => sample.pid))],
      latestHeapMb: heapMb.at(-1),
      peakHeapMb: Math.max(...heapMb),
      peakRssMb: Math.max(...samples.map((sample) => sample.rss / 1_048_576)),
      peakHeapRatio: Math.max(...ratios),
      postGcHeapMb: postGc.heapUsed / 1_048_576,
      postGcHeapRatio: postGc.heapUsed / postGc.heapLimit,
      earlyP95HeapMb: percentile(heapMb.slice(0, span), 0.95),
      lateP95HeapMb: percentile(heapMb.slice(-span), 0.95),
    };
  }

  async forceFullGc() {
    const request = `${this.metrics}.gc-request`;
    const done = `${this.metrics}.gc-done`;
    await rm(done, { force: true });
    await writeFile(request, `${Date.now()}\n`, "utf8");
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (existsSync(done)) return;
      await delay(25);
    }
    throw new Error("heap probe did not acknowledge the full-GC request");
  }

  async close() {
    if (this.child.exitCode !== null) return;
    try { await this.command("shutdown", {}, 20_000); }
    catch { /* Fall through to closing stdin. */ }
    this.child.stdin.end();
    const exit = await withTimeout(this.exited, 30_000, "CLI shutdown");
    assert.equal(exit.code, 0, `CLI shutdown failed (${JSON.stringify(exit)}): ${this.stderr.slice(-2_000)}`);
  }
}

function sendText(response, text, inputTokens) {
  startSse(response, inputTokens);
  event(response, { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
  event(response, { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } });
  event(response, { type: "content_block_stop", index: 0 });
  finishSse(response, "end_turn", Math.max(1, Math.ceil(text.length / 4)));
}

function sendTool(response, name, id, input, inputTokens) {
  startSse(response, inputTokens);
  event(response, { type: "content_block_start", index: 0, content_block: { type: "tool_use", id, name, input: {} } });
  event(response, { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } });
  event(response, { type: "content_block_stop", index: 0 });
  finishSse(response, "tool_use", 32);
}

function startSse(response, inputTokens) {
  response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
  event(response, {
    type: "message_start",
    message: {
      id: `msg_${Date.now()}`,
      type: "message",
      role: "assistant",
      model: "qwen3.8-flash",
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: inputTokens, output_tokens: 0 },
    },
  });
}

function finishSse(response, stopReason, outputTokens) {
  event(response, { type: "message_delta", delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: outputTokens } });
  event(response, { type: "message_stop" });
  response.end();
}

function event(response, value) {
  response.write(`event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`);
}

function inputTokens(stats) {
  if (stats.options.baseUsage) return stats.options.baseUsage;
  if (stats.options.highUsage) return 162_047;
  return Math.min(168_000, 112_000 + stats.sinceSummary * 4_000);
}

function lastMessageHasToolResult(messages) {
  const content = messages.at(-1)?.content;
  return Array.isArray(content) && content.some((block) => block?.type === "tool_result");
}

function countUserPrompts(messages) {
  return messages.filter((message) => message.role === "user"
    && !(Array.isArray(message.content) && message.content.some((block) => block?.type === "tool_result"))).length;
}

function subagentResult(messages) {
  const text = JSON.stringify(messages);
  const taskId = /Complete task ([^:\s]+)/u.exec(text)?.[1] ?? "stress-node";
  return {
    taskId,
    status: "completed",
    summary: "deterministic stress subagent completed",
    filesChanged: [],
    commandsRun: [],
    verification: [{ name: "stress", passed: true, details: "local provider response" }],
    artifacts: [],
    risks: [],
    suggestedNextSteps: [],
  };
}

function compactSummary() {
  return [
    "## Goal", "Continue the production memory stress run.",
    "## Completed", "Prior rounds completed without user-visible file changes.",
    "## Current state", "The local stress provider and session remain active.",
    "## Constraints", "Keep responses short and preserve task verification evidence.",
  ].join("\n");
}

function deterministicPayload(round, size) {
  const prefix = `round-${String(round).padStart(4, "0")}-`;
  return (prefix + "abcdefghijklmnopqrstuvwxyz0123456789").repeat(Math.ceil(size / (prefix.length + 36))).slice(0, size);
}

async function sessionSummary(workspace, sessionId) {
  const path = join(workspace, ".flavor", "sessions", `${sessionId}.jsonl`);
  const raw = await readFile(path, "utf8");
  const lines = raw.trim().split(/\r?\n/u);
  let roleMessageLines = 0;
  let timelineLines = 0;
  let lastTimelinePrompt;
  for (const line of lines) {
    const value = JSON.parse(line);
    if (typeof value.role === "string") roleMessageLines += 1;
    if (value.__timeline === true) {
      timelineLines += 1;
      if (typeof value.turn?.prompt === "string") lastTimelinePrompt = value.turn.prompt;
    }
  }
  return { bytes: Buffer.byteLength(raw), lines: lines.length, roleMessageLines, timelineLines, lastTimelinePrompt };
}

async function treeSummary(workspace, sessionId) {
  const path = join(workspace, ".flavor", "session-trees", sessionId, "tree.json");
  if (!existsSync(path)) return { exists: false, bytes: 0, nodes: 0, contextChars: 0 };
  const raw = await readFile(path, "utf8");
  const document = JSON.parse(raw);
  const nodes = Array.isArray(document.nodes) ? document.nodes : [];
  return {
    exists: true,
    bytes: Buffer.byteLength(raw),
    nodes: nodes.length,
    contextChars: nodes.reduce((total, node) => total + JSON.stringify(node.context).length, 0),
  };
}

function heapProbeSource() {
  return String.raw`
const fs = require("node:fs");
const v8 = require("node:v8");
const vm = require("node:vm");
const path = process.env.FLAVOR_STRESS_METRICS;
if (path) {
  const sample = (fullGc = false) => {
    const memory = process.memoryUsage();
    const heapLimit = v8.getHeapStatistics().heap_size_limit;
    try { fs.appendFileSync(path, JSON.stringify({
      at: Date.now(), pid: process.pid, argv: process.argv.join(" "),
      heapUsed: memory.heapUsed, heapTotal: memory.heapTotal, rss: memory.rss,
      external: memory.external, heapLimit, fullGc,
    }) + "\n"); } catch {}
  };
  const requestedGc = path + ".gc-request";
  const completedGc = path + ".gc-done";
  const maybeFullGc = () => {
    if (!fs.existsSync(requestedGc)) return;
    try { fs.unlinkSync(requestedGc); } catch {}
    try {
      v8.setFlagsFromString("--expose_gc");
      if (typeof global.gc !== "function") global.gc = vm.runInNewContext("gc");
      global.gc(); global.gc();
      sample(true);
      fs.writeFileSync(completedGc, String(Date.now()));
    } catch {}
  };
  sample();
  setInterval(() => { maybeFullGc(); sample(); }, 100).unref();
}
`;
}

function percentile(values, quantile) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * quantile))];
}

function percent(value) { return `${(value * 100).toFixed(1)}%`; }
function delay(ms) { return new Promise((resolvePromise) => setTimeout(resolvePromise, ms)); }

function withTimeout(promise, timeoutMs, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs); }),
  ]).finally(() => clearTimeout(timer));
}

function positiveInteger(raw, fallback) {
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`Expected a positive integer, received ${raw}`);
  return value;
}

await main();
