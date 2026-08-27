import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { createProductionRuntime as createRuntime, createPromptEnvironment, type ProductionRuntimeOptions } from "../../src/production.js";
import { SessionStore } from "../../src/session/store.js";
import { writeFile, mkdir } from "node:fs/promises";
import { createFileTokenStore } from "../../src/auth/store.js";
import { oauthCredentialId } from "../../src/auth/oauth-config.js";
import type { PalClientLike } from "../../src/pals/tools.js";
import type { BrokerEvent, CoWorkSnapshot, DeliveryReceipt, PalPresence } from "../../src/pals/protocol.js";

const createProductionRuntime = (options: ProductionRuntimeOptions) => createRuntime({ ...options, pluginSandbox: false });

const PAL_A = "10000000-0000-4000-8000-000000000001";
const PAL_B = "10000000-0000-4000-8000-000000000002";

class FakeProductionPalClient implements PalClientLike {
  readonly order: string[] = [];
  readonly listeners = new Set<(event: BrokerEvent) => void>();
  readonly close = vi.fn(async () => undefined);
  readonly start = vi.fn(async () => { this.order.push("start"); return this.presences[0]!; });
  readonly list = vi.fn(async () => this.presences);
  readonly rename = vi.fn(async (alias: string) => ({ ...this.presences[0]!, alias }));
  readonly sendTask = vi.fn(async (): Promise<DeliveryReceipt> => ({ version: 1, type: "delivery-receipt", messageId: crypto.randomUUID(), status: "delivered", recipientIds: [PAL_B] }));
  readonly sendChat = this.sendTask;
  readonly startCoWork = vi.fn(async (): Promise<CoWorkSnapshot> => { throw new Error("not used"); });
  readonly coWorkAction = vi.fn(async (): Promise<CoWorkSnapshot> => { throw new Error("not used"); });
  readonly coWorkStatus = vi.fn(async (): Promise<CoWorkSnapshot> => { throw new Error("not used"); });
  readonly integrateCoWork = vi.fn(async (): Promise<CoWorkSnapshot> => { throw new Error("not used"); });
  readonly cancelCoWork = vi.fn(async (): Promise<CoWorkSnapshot> => { throw new Error("not used"); });
  constructor(readonly presences: PalPresence[] = [
    { version: 1, id: PAL_A, alias: "app", projectPath: "/work/app", connectedAt: new Date(0).toISOString(), lastSeenAt: new Date(0).toISOString() },
    { version: 1, id: PAL_B, alias: "api", projectPath: "/work/api", connectedAt: new Date(0).toISOString(), lastSeenAt: new Date(0).toISOString() },
  ]) {}
  subscribe(listener: (event: BrokerEvent) => void): () => void {
    this.order.push("subscribe"); this.listeners.add(listener); return () => this.listeners.delete(listener);
  }
  emit(event: BrokerEvent): void { for (const listener of this.listeners) listener(event); }
}

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("production runtime", () => {
  it("loads legacy Node plugins and their skill roots by default", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "flavor-production-plugin-compat-")); roots.push(workspace);
    const plugin = join(workspace, ".flavor", "plugins", "legacy-default");
    const skillRoot = join(plugin, "skills", "go");
    await mkdir(skillRoot, { recursive: true });
    await writeFile(join(plugin, "flavor-plugin.json"), JSON.stringify({
      name: "legacy-default", version: "1.0.0", apiVersion: "1", main: "index.mjs", permissions: [],
      contributes: {
        commands: [{ name: "legacy-read" }], tools: [], hooks: [],
        skillRoots: [{ name: "legacy-skills", path: "skills" }], modelAdapters: [],
      },
    }));
    await writeFile(join(plugin, "content.txt"), "plugin content", "utf8");
    await writeFile(join(skillRoot, "SKILL.md"), [
      "---", "name: go", "description: Run the legacy workflow", "---", "", "Go skill body.", "",
    ].join("\n"), "utf8");
    await writeFile(join(plugin, "index.mjs"), `
      import { readFileSync } from "node:fs";
      import { dirname, join } from "node:path";
      import { fileURLToPath } from "node:url";
      const root = dirname(fileURLToPath(import.meta.url));
      export function activate(context) {
        context.registerCommand("legacy-read", () => readFileSync(join(root, "content.txt"), "utf8"));
        context.registerSkillRoot("legacy-skills", "skills");
      }
    `, "utf8");

    const runtime = await createRuntime({ workspace, home: workspace, environment: {}, approvalPolicy: "deny", output: () => {} });
    try {
      expect(runtime.services.plugins()).toEqual([
        expect.objectContaining({ name: "legacy-default", sandboxed: false, fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/) }),
      ]);
      expect(runtime.services.pluginCommands()).toContainEqual(expect.objectContaining({ name: "legacy-read" }));
      await expect(runtime.services.runPluginCommand("legacy-read", [], new AbortController().signal)).resolves.toBe("plugin content");
      expect((await runtime.services.skills()).map(({ name }) => name)).toContain("go");
    } finally { await runtime.dispose(); }
  });

  it("keeps Worker/vm plugin isolation available as an explicit opt-in", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "flavor-production-plugin-sandbox-")); roots.push(workspace);
    const plugin = join(workspace, ".flavor", "plugins", "safe-opt-in");
    await mkdir(plugin, { recursive: true });
    await writeFile(join(plugin, "flavor-plugin.json"), JSON.stringify({
      name: "safe-opt-in", version: "1.0.0", apiVersion: "1", main: "index.mjs", permissions: [],
      contributes: { commands: [], tools: [], hooks: [], skillRoots: [], modelAdapters: [] },
    }));
    await writeFile(join(plugin, "index.mjs"), "export function activate() {}", "utf8");

    const runtime = await createRuntime({
      workspace, home: workspace, environment: {}, approvalPolicy: "deny", pluginSandbox: true, output: () => {},
    });
    try {
      expect(runtime.services.plugins()).toEqual([
        expect.objectContaining({ name: "safe-opt-in", sandboxed: true, fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/) }),
      ]);
    } finally { await runtime.dispose(); }
  });

  it("delivers collaboration events in broker socket order even when an earlier event awaits", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "flavor-production-pals-order-")); roots.push(workspace);
    const client = new FakeProductionPalClient();
    let releaseFirstList!: () => void;
    const firstList = new Promise<void>((resolve) => { releaseFirstList = resolve; });
    client.list.mockImplementationOnce(async () => {
      await firstList;
      return client.presences;
    });
    const actions: string[] = [];
    const runtime = await createProductionRuntime({
      workspace, home: workspace, environment: {},
      output: (event) => { if (event.type === "cowork-event") actions.push(event.action); },
      collaboration: { instanceId: PAL_A, client },
    });
    const coWorkId = "40000000-0000-4000-8000-000000000001";
    const planHash = "a".repeat(64);
    const snapshot = {
      version: 1 as const, coWorkId, epoch: 1, phase: "planning" as const, goal: "coordinate",
      participants: [{ palId: PAL_A, required: true }, { palId: PAL_B, required: true }],
      integrationOwnerId: PAL_A,
      acceptedParticipantIds: [PAL_A, PAL_B], planHash,
      plan: {
        version: 1 as const, coWorkId, epoch: 1, goal: "coordinate",
        participants: [{ palId: PAL_A, required: true }, { palId: PAL_B, required: true }],
        tasks: [{ id: "a", assigneeId: PAL_A, description: "adapt", dependsOn: [] }],
      },
      planAcceptedParticipantIds: [], readyParticipantIds: [], completedParticipantIds: [],
      completionAssertions: [], integration: null,
    } satisfies CoWorkSnapshot;
    const event = (action: "PROPOSE" | "PLAN" | "START"): BrokerEvent => ({
      version: 1, type: "cowork-event", action, actorId: PAL_B, coWorkId, epoch: 1,
      planHash: action === "PROPOSE" ? null : planHash,
      snapshot: { ...snapshot, phase: action === "START" ? "running" : "planning" },
    });

    client.emit(event("PROPOSE"));
    client.emit(event("PLAN"));
    client.emit(event("START"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(actions).toEqual([]);
    releaseFirstList();
    await vi.waitFor(() => expect(actions).toEqual(["PROPOSE", "PLAN", "START"]));

    await runtime.session.whenIdle();
    await runtime.dispose();
  });

  it("records one collaboration event failure and continues pumping later events", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "flavor-production-pals-pump-error-")); roots.push(workspace);
    const client = new FakeProductionPalClient();
    const outputs: unknown[] = [];
    const runtime = await createProductionRuntime({
      workspace, home: workspace, environment: {}, output: (event) => outputs.push(event),
      collaboration: { instanceId: PAL_A, client },
    });
    const coWorkId = "40000000-0000-4000-8000-000000000009";
    client.emit({
      version: 1, type: "cowork-event", action: "PROPOSE", actorId: PAL_B, coWorkId, epoch: 1, planHash: null,
      snapshot: {
        version: 1, coWorkId, epoch: 1, phase: "proposed", goal: "fail acceptance",
        participants: [{ palId: PAL_A, required: true }, { palId: PAL_B, required: true }],
        integrationOwnerId: PAL_A,
        acceptedParticipantIds: [PAL_B], planHash: null, plan: null,
        planAcceptedParticipantIds: [], readyParticipantIds: [], completedParticipantIds: [], completionAssertions: [], integration: null,
      },
    });
    client.emit({
      version: 1, type: "chat-event", messageId: "20000000-0000-4000-8000-000000000009",
      senderId: PAL_B, recipientId: PAL_A, message: "continue after failure",
    });

    await vi.waitFor(() => expect(outputs).toContainEqual(expect.objectContaining({
      type: "pal-task", goal: "continue after failure",
    })));
    expect(runtime.diagnostics).toContainEqual(expect.stringMatching(/Pal event failed: not used/));
    await runtime.session.whenIdle();
    await runtime.dispose();
  });

  it("delivers proposals to optional observers without making them join the required acceptance barrier", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "flavor-production-pals-observer-")); roots.push(workspace);
    const client = new FakeProductionPalClient();
    const outputs: unknown[] = [];
    const runtime = await createProductionRuntime({
      workspace, home: workspace, environment: {}, output: (event) => outputs.push(event),
      collaboration: { instanceId: PAL_A, client },
    });
    const coWorkId = "40000000-0000-4000-8000-000000000008";
    client.emit({
      version: 1, type: "cowork-event", action: "PROPOSE", actorId: PAL_B, coWorkId, epoch: 1, planHash: null,
      snapshot: {
        version: 1, coWorkId, epoch: 1, phase: "proposed", goal: "observe required peer coordination",
        participants: [{ palId: PAL_B, required: true }, { palId: PAL_A, required: false }],
        integrationOwnerId: PAL_B,
        acceptedParticipantIds: [PAL_B], planHash: null, plan: null,
        planAcceptedParticipantIds: [], readyParticipantIds: [], completedParticipantIds: [], completionAssertions: [], integration: null,
      },
    });

    await vi.waitFor(() => expect(outputs).toContainEqual(expect.objectContaining({
      type: "cowork-event", action: "PROPOSE", coWorkId,
    })));
    expect(client.coWorkAction).not.toHaveBeenCalled();
    await runtime.session.whenIdle();
    await runtime.dispose();
  });

  it("keeps collaboration opt-in and wires subscribed inbound tasks to the session exactly once", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "flavor-production-pals-")); roots.push(workspace);
    const disabled = await createProductionRuntime({ workspace, home: workspace, environment: {}, output: () => {} });
    expect(disabled.services.pals).toBeUndefined();
    await disabled.dispose();

    const client = new FakeProductionPalClient();
    const outputs: unknown[] = [];
    const incoming = {
      version: 1 as const, type: "task-event" as const,
      messageId: "20000000-0000-4000-8000-000000000001", taskId: "30000000-0000-4000-8000-000000000001",
      senderId: PAL_B, recipientId: PAL_A, status: "accepted" as const, detail: "update the API",
    };
    client.start.mockImplementationOnce(async () => {
      client.order.push("start");
      client.emit(incoming);
      return client.presences[0]!;
    });
    const createClient = vi.fn(() => client);
    const runtime = await createProductionRuntime({
      workspace, home: workspace, environment: {}, output: (event) => outputs.push(event),
      collaboration: { instanceId: PAL_A, alias: "app", createClient },
    });
    expect(createClient).toHaveBeenCalledWith({ instanceId: PAL_A, alias: "app", projectPath: workspace });
    expect(runtime.sessionId).not.toBe(PAL_A);
    expect(client.order.slice(0, 2)).toEqual(["subscribe", "start"]);
    expect(runtime.services.pals).toBeDefined();
    client.emit(incoming);
    await vi.waitFor(() => expect(outputs.filter((event) => (event as { type?: string }).type === "pal-task")).toHaveLength(1));
    await runtime.session.whenIdle();
    expect(outputs.filter((event) => (event as { type?: string }).type === "pal-task")).toEqual([
      expect.objectContaining({ senderAlias: "api", goal: "update the API" }),
    ]);
    await runtime.services.clearContext();
    expect(runtime.sessionId).not.toBe(PAL_A);
    expect(createClient).toHaveBeenCalledTimes(1);
    expect(client.start).toHaveBeenCalledTimes(1);
    await runtime.dispose();
    expect(client.close).toHaveBeenCalledOnce();
  });

  it("abandons a hung collaboration close instead of blocking dispose", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "flavor-production-pals-hang-")); roots.push(workspace);
    const client = new FakeProductionPalClient();
    client.close.mockImplementation(() => new Promise<undefined>(() => undefined));
    const runtime = await createProductionRuntime({
      workspace, home: workspace, environment: {}, output: () => {},
      collaboration: { instanceId: PAL_A, alias: "app", client },
      shutdownStepTimeoutMs: 50,
    });
    const started = Date.now();
    await runtime.dispose();
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(client.close).toHaveBeenCalledOnce();
    expect(runtime.diagnostics.join(" ")).toContain("collaboration-close");
  });

  it("uses a safe UUID fallback for unknown senders and closes collaboration after construction failure", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "flavor-production-pals-failure-")); roots.push(workspace);
    const unknown = new FakeProductionPalClient([{
      version: 1, id: PAL_A, alias: "app", projectPath: "/work/app", connectedAt: new Date(0).toISOString(), lastSeenAt: new Date(0).toISOString(),
    }]);
    const outputs: unknown[] = [];
    const runtime = await createProductionRuntime({ workspace, home: workspace, environment: {}, output: (event) => outputs.push(event), collaboration: { instanceId: PAL_A, client: unknown } });
    unknown.emit({
      version: 1, type: "task-event", messageId: "20000000-0000-4000-8000-000000000002",
      taskId: "30000000-0000-4000-8000-000000000002", senderId: PAL_B, recipientId: PAL_A, status: "accepted", detail: "hello",
    });
    await runtime.session.whenIdle();
    expect(outputs).toContainEqual(expect.objectContaining({ type: "pal-task", senderAlias: "10000000" }));
    await runtime.dispose();

    const failing = new FakeProductionPalClient();
    await expect(createProductionRuntime({
      workspace, home: workspace, environment: {}, output: () => {}, collaboration: { instanceId: PAL_A, client: failing },
      extraTools: [{ name: "Broken", description: "broken", inputSchema: {} as never, paths: () => [], execute: async () => undefined }],
    })).rejects.toThrow();
    expect(failing.close).toHaveBeenCalledOnce();
  });

  it("can degrade optional desktop collaboration without failing session startup", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "flavor-production-pals-optional-")); roots.push(workspace);
    const failing = new FakeProductionPalClient();
    failing.start.mockRejectedValueOnce(new Error("broker unavailable"));

    const runtime = await createProductionRuntime({
      workspace, home: workspace, environment: {}, output: () => {},
      collaboration: { instanceId: PAL_A, client: failing, optional: true },
    });

    expect(runtime.diagnostics).toContainEqual(expect.stringMatching(/Pals unavailable.*broker unavailable/i));
    expect(failing.close).not.toHaveBeenCalled();
    await expect(runtime.services.pals?.list(true)).resolves.toEqual(expect.arrayContaining([expect.objectContaining({ alias: "app" })]));
    expect(failing.start).toHaveBeenCalledTimes(2);
    expect(runtime.diagnostics).not.toContainEqual(expect.stringMatching(/Pals unavailable/i));
    await runtime.dispose();
    expect(failing.close).toHaveBeenCalledOnce();
  });

  it("registers collaboration tools with the main harness only when collaboration is enabled", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "flavor-production-pals-tools-")); roots.push(workspace);
    const pluginRoot = join(workspace, ".flavor", "plugins", "capture-pals-tools");
    await mkdir(pluginRoot, { recursive: true });
    await writeFile(join(workspace, ".flavor", "flavor.json"), JSON.stringify({
      providers: { capture: { type: "plugin", defaultModel: "main", cheapModel: "child" } },
      agents: { main: { model: "capture:main" }, subagent: { model: "capture:child" } },
    }));
    await writeFile(join(pluginRoot, "flavor-plugin.json"), JSON.stringify({
      name: "capture-pals-tools", version: "1.0.0", apiVersion: "1", main: "index.mjs", permissions: [],
      contributes: { commands: [], tools: [], hooks: [], skillRoots: [], modelAdapters: [{ name: "capture" }] },
    }));
    await writeFile(join(pluginRoot, "index.mjs"), `export function activate(ctx) {
      ctx.registerModelAdapter("capture", { async *stream(request) {
        globalThis.__flavorPalsTools ??= [];
        globalThis.__flavorPalsTools.push(request.tools.map((tool) => tool.name));
        yield { type: "text", text: "done" };
        yield { type: "done", usage: { inputTokens: 0, outputTokens: 0 } };
      }});
    }`);
    const state = globalThis as typeof globalThis & { __flavorPalsTools?: string[][] };
    delete state.__flavorPalsTools;
    const disabled = await createProductionRuntime({ workspace, home: workspace, environment: {}, output: () => {} });
    await disabled.session.submit("list tools");
    await disabled.dispose();
    const enabled = await createProductionRuntime({
      workspace, home: workspace, environment: {}, output: () => {},
      collaboration: { instanceId: PAL_A, client: new FakeProductionPalClient() },
    });
    await enabled.session.submit("list tools again");
    await enabled.dispose();
    expect(state.__flavorPalsTools?.[0]).not.toContain("PalsList");
    expect(state.__flavorPalsTools?.[1]).toEqual(expect.arrayContaining([
      "PalsList", "PalSend", "CoWorkState", "CoWorkPlan", "CoWorkReady", "CoWorkProgress", "CoWorkComplete",
      "CoWorkIntegrate",
    ]));
    delete state.__flavorPalsTools;
  });

  it("redacts configured secrets before a model collaboration tool reaches the client", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "flavor-production-pals-redact-")); roots.push(workspace);
    const pluginRoot = join(workspace, ".flavor", "plugins", "pals-redact-model");
    await mkdir(pluginRoot, { recursive: true });
    await writeFile(join(workspace, ".flavor", "flavor.json"), JSON.stringify({
      providers: { capture: { type: "plugin", defaultModel: "main", cheapModel: "child" } },
      agents: { main: { model: "capture:main" }, subagent: { model: "capture:child" } },
      permissionMode: "bypassPermissions",
    }));
    await writeFile(join(pluginRoot, "flavor-plugin.json"), JSON.stringify({
      name: "pals-redact-model", version: "1.0.0", apiVersion: "1", main: "index.mjs", permissions: [],
      contributes: { commands: [], tools: [], hooks: [], skillRoots: [], modelAdapters: [{ name: "capture" }] },
    }));
    const secret = "sk-production-sharing-secret";
    await writeFile(join(pluginRoot, "index.mjs"), `export function activate(ctx) {
      let calls = 0;
      ctx.registerModelAdapter("capture", { async *stream() {
        if (calls++ === 0) yield { type: "tool-call", id: "share-1", name: "PalSend", input: { target: "api", message: ${JSON.stringify(`credential=${secret}`)} } };
        else yield { type: "text", text: "done" };
        yield { type: "done", usage: { inputTokens: 0, outputTokens: 0 } };
      }});
    }`);
    const client = new FakeProductionPalClient();
    const runtime = await createProductionRuntime({
      workspace, home: workspace, environment: { OPENAI_API_KEY: secret }, output: () => {},
      collaboration: { instanceId: PAL_A, client },
    });
    await runtime.session.submit("share status");
    expect(client.sendChat).toHaveBeenCalledWith(PAL_B, "credential=[redacted]");
    await runtime.dispose();
  });

  it("rejects /co-work when the resolved target is the local CLI instance", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "flavor-production-pals-self-")); roots.push(workspace);
    const client = new FakeProductionPalClient();
    const runtime = await createProductionRuntime({
      workspace, home: workspace, environment: {}, output: () => {},
      collaboration: { instanceId: PAL_A, client },
    });

    await expect(runtime.services.pals!.startCoWork("app", "coordinate"))
      .rejects.toThrow(/itself|local instance|self/i);
    expect(client.startCoWork).not.toHaveBeenCalled();
    await runtime.dispose();
  });

  it("does not resolve UUID prefixes shorter than the shared minimum", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "flavor-production-pals-prefix-")); roots.push(workspace);
    const client = new FakeProductionPalClient([{
      version: 1, id: PAL_A, alias: "app", projectPath: "/work/app",
      connectedAt: new Date(0).toISOString(), lastSeenAt: new Date(0).toISOString(),
    }]);
    const runtime = await createProductionRuntime({
      workspace, home: workspace, environment: {}, output: () => {}, collaboration: { instanceId: PAL_A, client },
    });
    await expect(runtime.services.pals!.info("1000")).rejects.toThrow(/not active/i);
    await runtime.dispose();
  });
  it("uses PKCE runtime metadata instead of stale project model fields", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "flavor-production-pkce-")); roots.push(workspace);
    await mkdir(join(workspace, ".flavor"), { recursive: true });
    const tokenUrl = "https://auth.example.test/token";
    await writeFile(join(workspace, ".flavor", "flavor.json"), JSON.stringify({
      providers: { company: {
        type: "oauth-callback", authorizationUrl: "https://auth.example.test/authorize",
        tokenUrl, clientId: "flavor-code-cli", defaultModel: "stale-main", cheapModel: "stale-child",
      } },
      agents: { main: { model: "company:stale-main" }, subagent: { model: "company:stale-child" } },
    }));
    const store = createFileTokenStore(join(workspace, ".flavor-code", "auth.json"));
    await store.save({
      [oauthCredentialId(tokenUrl, "flavor-code-cli")]: {
        accessToken: "signed-gateway-jwt", expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        configVersion: 4,
        llmConfig: {
          providerId: "deepseek", serviceName: "Enterprise DeepSeek", apiType: "anthropic",
          baseURL: "http://127.0.0.1:8092", defaultModel: "deepseek-v4-pro",
          cheapModel: "deepseek-v4-flash", models: ["deepseek-v4-pro", "deepseek-v4-flash"],
          maxOutputTokens: 65536,
        },
      },
    });

    const runtime = await createProductionRuntime({
      workspace, home: workspace, environment: {}, approvalPolicy: "deny", output: () => {},
    });
    expect(runtime.services.mainModel()).toBe("deepseek:deepseek-v4-pro");
    expect(runtime.services.subagentModel()).toBe("deepseek:deepseek-v4-flash");
    expect(runtime.services.config()).toMatchObject({
      effectiveLlm: { serviceName: "Enterprise DeepSeek", baseURL: "http://127.0.0.1:8092", configVersion: 4 },
    });
    await runtime.dispose();
  });

  it("summarises session cache usage from the usage log", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "flavor-production-usage-")); roots.push(workspace);
    const usageFile = join(workspace, "usage.jsonl");
    const previousUsageFile = process.env.FLAVOR_USAGE_FILE;
    process.env.FLAVOR_USAGE_FILE = usageFile;
    try {
      await writeFile(usageFile, JSON.stringify({
        event: "flavor-usage", sessionId: "session-a", provider: "anthropic", model: "qwen3.8-max",
        inputTokens: 10, cacheReadTokens: 90, cacheCreationTokens: 20, totalInputTokens: 120, cacheHitRatio: 0.75,
      }));
      const runtime = await createProductionRuntime({
        workspace, home: workspace, environment: {}, approvalPolicy: "deny", output: () => {},
      });
      try {
        const text = await runtime.services.usage();
        expect(text).toContain("Usage for session session-a (1 request):");
        expect(text).toContain("qwen3.8-max");
        expect(text).toContain("Total input tokens: 120 (cache read 90, 75.0%)");
      } finally {
        await runtime.dispose();
      }
    } finally {
      if (previousUsageFile === undefined) delete process.env.FLAVOR_USAGE_FILE;
      else process.env.FLAVOR_USAGE_FILE = previousUsageFile;
    }
  });

  it("reports a friendly message when the usage log does not exist yet", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "flavor-production-usage-empty-")); roots.push(workspace);
    const previousUsageFile = process.env.FLAVOR_USAGE_FILE;
    process.env.FLAVOR_USAGE_FILE = join(workspace, "missing-usage.jsonl");
    try {
      const runtime = await createProductionRuntime({
        workspace, home: workspace, environment: {}, approvalPolicy: "deny", output: () => {},
      });
      try {
        expect(await runtime.services.usage()).toBe("No usage recorded in this session yet.");
      } finally {
        await runtime.dispose();
      }
    } finally {
      if (previousUsageFile === undefined) delete process.env.FLAVOR_USAGE_FILE;
      else process.env.FLAVOR_USAGE_FILE = previousUsageFile;
    }
  });

  it("sends the PKCE model name and JWT to the configured gateway", async () => {
    const requests: Array<{ url: string; body: Record<string, unknown>; apiKey?: string }> = [];
    const gateway = createServer((request, response) => {
      let raw = "";
      request.on("data", (chunk: Buffer) => { raw += chunk.toString("utf8"); });
      request.on("end", () => {
        requests.push({
          url: request.url ?? "", body: JSON.parse(raw),
          ...(request.headers["x-api-key"] === undefined ? {} : { apiKey: String(request.headers["x-api-key"]) }),
        });
        response.writeHead(200, { "Content-Type": "text/event-stream" });
        response.end([
          'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":3,"output_tokens":0}}}\n',
          'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}\n',
          'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n',
          'event: message_stop\ndata: {"type":"message_stop"}\n\n',
        ].join("\n"));
      });
    });
    await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
    const port = (gateway.address() as AddressInfo).port;
    const workspace = await mkdtemp(join(tmpdir(), "flavor-production-pkce-call-")); roots.push(workspace);
    await mkdir(join(workspace, ".flavor"), { recursive: true });
    const tokenUrl = "https://auth.example.test/token";
    await writeFile(join(workspace, ".flavor", "flavor.json"), JSON.stringify({
      providers: { company: { type: "oauth-callback", authorizationUrl: "https://auth.example.test/authorize", tokenUrl, clientId: "flavor-code-cli" } },
      agents: { main: { model: "company:stale" }, subagent: { model: "company:stale-child" } },
      memory: { enabled: false }, hallucination: { showWarnings: false }, sleep: false,
    }));
    await createFileTokenStore(join(workspace, ".flavor-code", "auth.json")).save({
      [oauthCredentialId(tokenUrl, "flavor-code-cli")]: {
        accessToken: "signed-gateway-jwt", expiresAt: new Date(Date.now() + 3600_000).toISOString(), configVersion: 9,
        llmConfig: {
          providerId: "deepseek", serviceName: "Enterprise DeepSeek", apiType: "anthropic",
          baseURL: `http://127.0.0.1:${port}`, defaultModel: "deepseek-v4-pro", cheapModel: "deepseek-v4-flash",
          models: ["deepseek-v4-pro", "deepseek-v4-flash"], maxOutputTokens: 1024,
        },
      },
    });
    const runtime = await createProductionRuntime({ workspace, home: workspace, environment: {}, approvalPolicy: "deny", output: () => {} });
    try {
      await runtime.session.submit("answer briefly");
      expect(runtime.services.mainModel()).toBe("deepseek:deepseek-v4-pro");
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({
        url: "/v1/messages", apiKey: "signed-gateway-jwt", body: { model: "deepseek-v4-pro" },
      });
    } finally {
      await runtime.dispose();
      await new Promise<void>((resolve) => gateway.close(() => resolve()));
    }
  }, 15_000);
  it("creates deterministic prompt environment data with explicit fallbacks", () => {
    expect(createPromptEnvironment({
      now: new Date(2026, 6, 13, 23, 59),
      platform: "win32",
      osVersion: "Windows 11 10.0.26100",
      shell: "powershell.exe",
      isGitRepository: true,
    })).toEqual({
      date: "2026-07-13",
      platform: "win32",
      osVersion: "Windows 11 10.0.26100",
      shell: "powershell.exe",
      isGitRepository: true,
    });
    expect(createPromptEnvironment({
      now: new Date("invalid"), platform: " ", osVersion: "", shell: "\n", isGitRepository: "unknown",
    })).toEqual({
      date: "unknown", platform: "unknown", osVersion: "unknown", shell: "unknown", isGitRepository: "unknown",
    });
  });

  it("uses the local calendar date instead of the UTC date", () => {
    const localEarlyMorning = new Date(2026, 7, 3, 0, 30);

    expect(createPromptEnvironment({ now: localEarlyMorning }).date).toBe("2026-08-03");
  });

  it("does not advertise AskUserQuestion in non-interactive mode", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "flavor-production-")); roots.push(workspace);
    const pluginRoot = join(workspace, ".flavor", "plugins", "capture-model");
    await mkdir(pluginRoot, { recursive: true });
    await writeFile(join(workspace, ".flavor", "flavor.json"), JSON.stringify({
      providers: { capture: { type: "plugin", defaultModel: "main", cheapModel: "child" } },
      agents: { main: { model: "capture:main" }, subagent: { model: "capture:child" } },
    }));
    await writeFile(join(pluginRoot, "flavor-plugin.json"), JSON.stringify({
      name: "capture-model", version: "1.0.0", apiVersion: "1", main: "index.mjs", permissions: [],
      contributes: { commands: [], tools: [], hooks: [], skillRoots: [], modelAdapters: [{ name: "capture" }] },
    }));
    await writeFile(join(pluginRoot, "index.mjs"), `export function activate(ctx) {
      ctx.registerModelAdapter("capture", { async *stream(request) {
        globalThis.__flavorPromptRequests ??= [];
        globalThis.__flavorPromptRequests.push({
          tools: request.tools.map((tool) => tool.name),
          system: request.messages.filter((message) => message.role === "system").map((message) => message.content).join("\\n\\n"),
        });
        yield { type: "text", text: "done" };
        yield { type: "done", usage: { inputTokens: 0, outputTokens: 0 } };
      }});
    }`);
    const globalState = globalThis as typeof globalThis & { __flavorPromptRequests?: Array<{ tools: string[]; system: string }> };
    delete globalState.__flavorPromptRequests;
    const runtime = await createProductionRuntime({
      workspace, home: workspace, environment: {}, approvalPolicy: "deny", output: () => {},
    });

    await runtime.session.start();
    await runtime.session.submit("inspect the project");

    const requests = (globalThis as { __flavorPromptRequests?: Array<{ tools: string[]; system: string }> })
      .__flavorPromptRequests;
    expect(requests).toHaveLength(1);
    expect(requests?.[0]?.tools).not.toContain("AskUserQuestion");
    expect(requests?.[0]?.system).not.toContain("`AskUserQuestion`");
    await runtime.dispose();
    delete globalState.__flavorPromptRequests;
  });

  it("advertises configured MCP tools and closes their clients on disposal", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "flavor-production-mcp-")); roots.push(workspace);
    const pluginRoot = join(workspace, ".flavor", "plugins", "capture-mcp-model");
    await mkdir(pluginRoot, { recursive: true });
    await writeFile(join(workspace, ".flavor", "flavor.json"), JSON.stringify({
      providers: { capture: { type: "plugin", defaultModel: "main", cheapModel: "child" } },
      agents: { main: { model: "capture:main" }, subagent: { model: "capture:child" } },
      mcpServers: { docs: { command: "node", args: ["server.js"] } },
    }));
    await writeFile(join(pluginRoot, "flavor-plugin.json"), JSON.stringify({
      name: "capture-mcp-model", version: "1.0.0", apiVersion: "1", main: "index.mjs", permissions: [],
      contributes: { commands: [], tools: [], hooks: [], skillRoots: [], modelAdapters: [{ name: "capture" }] },
    }));
    await writeFile(join(pluginRoot, "index.mjs"), `export function activate(ctx) {
      ctx.registerModelAdapter("capture", { async *stream(request) {
        globalThis.__flavorMcpTools = request.tools.map((tool) => tool.name);
        yield { type: "text", text: "done" };
        yield { type: "done", usage: { inputTokens: 0, outputTokens: 0 } };
      }});
    }`);
    const close = vi.fn(async () => undefined);
    const mcpClientFactory = vi.fn(async () => ({
      listTools: async () => ({ tools: [{
        name: "search", description: "Search docs", inputSchema: { type: "object" },
      }] }),
      callTool: async () => ({ content: [] }),
      close,
    }));
    const globalState = globalThis as typeof globalThis & { __flavorMcpTools?: string[] };
    delete globalState.__flavorMcpTools;

    const runtime = await createProductionRuntime({
      workspace, home: workspace, environment: {}, approvalPolicy: "deny", output: () => {},
      mcpClientFactory,
    });
    await runtime.session.start();
    await runtime.session.submit("inspect MCP tools");

    expect(mcpClientFactory).toHaveBeenCalledWith(expect.objectContaining({ name: "docs", workspace }));
    expect(globalState.__flavorMcpTools).toContain("mcp__docs__search");
    await runtime.dispose();
    await runtime.dispose();
    expect(close).toHaveBeenCalledTimes(1);
    delete globalState.__flavorMcpTools;
  });

  it("updates model-visible MCP tools when project servers are disabled and enabled", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "flavor-production-mcp-manage-")); roots.push(workspace);
    const pluginRoot = join(workspace, ".flavor", "plugins", "capture-mcp-management");
    await mkdir(pluginRoot, { recursive: true });
    const configPath = join(workspace, ".flavor", "flavor.json");
    await writeFile(configPath, JSON.stringify({
      providers: { capture: { type: "plugin", defaultModel: "main", cheapModel: "child" } },
      agents: { main: { model: "capture:main" }, subagent: { model: "capture:child" } },
      mcpServers: { docs: { command: "node", args: ["server.js"] } },
    }));
    await writeFile(join(pluginRoot, "flavor-plugin.json"), JSON.stringify({
      name: "capture-mcp-management", version: "1.0.0", apiVersion: "1", main: "index.mjs", permissions: [],
      contributes: { commands: [], tools: [], hooks: [], skillRoots: [], modelAdapters: [{ name: "capture" }] },
    }));
    await writeFile(join(pluginRoot, "index.mjs"), `export function activate(ctx) {
      ctx.registerModelAdapter("capture", { async *stream(request) {
        globalThis.__flavorMcpToolSnapshots ??= [];
        globalThis.__flavorMcpToolSnapshots.push(request.tools.map((tool) => tool.name));
        yield { type: "text", text: "done" };
        yield { type: "done", usage: { inputTokens: 0, outputTokens: 0 } };
      }});
    }`);
    const globalState = globalThis as typeof globalThis & { __flavorMcpToolSnapshots?: string[][] };
    delete globalState.__flavorMcpToolSnapshots;
    const clients: Array<{ close: ReturnType<typeof vi.fn> }> = [];
    const mcpClientFactory = vi.fn(async () => {
      const client = {
        listTools: async () => ({ tools: [{ name: "search", description: "Search docs", inputSchema: { type: "object" } }] }),
        callTool: async () => ({ content: [] }),
        close: vi.fn(async () => undefined),
      };
      clients.push(client);
      return client;
    });
    const outputs: string[] = [];
    const runtime = await createProductionRuntime({
      workspace, home: workspace, environment: {}, approvalPolicy: "deny",
      output: (event) => { if (event.type === "notice") outputs.push(event.message); },
      mcpClientFactory,
    });

    await runtime.session.submit("/mcp");
    await runtime.session.submit("/mcp tools docs");
    await runtime.session.submit("before toggle");
    await runtime.session.submit("/mcp disable docs");
    await runtime.session.submit("after disable");
    expect(JSON.parse(await readFile(configPath, "utf8")).mcpServers.docs.disabled).toBe(true);
    await runtime.session.submit("/mcp enable docs");
    await runtime.session.submit("after enable");

    expect(globalState.__flavorMcpToolSnapshots).toHaveLength(3);
    expect(globalState.__flavorMcpToolSnapshots?.[0]).toContain("mcp__docs__search");
    expect(globalState.__flavorMcpToolSnapshots?.[0]).toEqual(expect.arrayContaining([
      "WebFetch", "WebSearch", "JobList", "JobRead", "JobWait", "JobKill",
      "TerminalOpen", "TerminalWrite", "TerminalRead", "TerminalResize", "TerminalClose", "TerminalList",
    ]));
    expect(globalState.__flavorMcpToolSnapshots?.[1]).not.toContain("mcp__docs__search");
    expect(globalState.__flavorMcpToolSnapshots?.[2]).toContain("mcp__docs__search");
    expect(outputs.join("\n")).toContain("Disabled MCP server \"docs\"");
    expect(outputs.join("\n")).toContain("Enabled MCP server \"docs\"");
    expect(outputs.join("\n")).toContain("docs  connected  stdio  1 tool");
    expect(outputs.join("\n")).toContain("search -> mcp__docs__search");
    expect(mcpClientFactory).toHaveBeenCalledTimes(2);
    expect(clients[0]?.close).toHaveBeenCalledTimes(1);
    await runtime.dispose();
    expect(clients[1]?.close).toHaveBeenCalledTimes(1);
    delete globalState.__flavorMcpToolSnapshots;
  });

  it("runs /loop through a fresh worker and host verifier", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "flavor-production-loop-")); roots.push(workspace);
    const pluginRoot = join(workspace, ".flavor", "plugins", "loop-model");
    await mkdir(pluginRoot, { recursive: true });
    await writeFile(join(workspace, "package.json"), JSON.stringify({
      name: "loop-fixture", private: true,
      scripts: { test: "node -e \"require('node:fs').accessSync('package.json')\"" },
    }));
    await writeFile(join(workspace, ".flavor", "flavor.json"), JSON.stringify({
      providers: { capture: { type: "plugin", defaultModel: "main", cheapModel: "child" } },
      agents: { main: { model: "capture:main" }, subagent: { model: "capture:child" } },
      loop: { maxCycles: 3, maxTokens: 1000, isolation: "auto" },
    }));
    await writeFile(join(pluginRoot, "flavor-plugin.json"), JSON.stringify({
      name: "loop-model", version: "1.0.0", apiVersion: "1", main: "index.mjs", permissions: [],
      contributes: { commands: [], tools: [], hooks: [], skillRoots: [], modelAdapters: [{ name: "capture" }] },
    }));
    await writeFile(join(pluginRoot, "index.mjs"), `export function activate(ctx) {
      ctx.registerModelAdapter("capture", { async *stream(request) {
        globalThis.__flavorLoopRequests ??= [];
        globalThis.__flavorLoopRequests.push(request.messages);
        yield { type: "text", text: "Ready for host verification." };
        yield { type: "usage", inputTokens: 10, outputTokens: 5 };
        yield { type: "done", usage: { inputTokens: 10, outputTokens: 5 } };
      }});
    }`);
    const globalState = globalThis as typeof globalThis & { __flavorLoopRequests?: unknown[][] };
    delete globalState.__flavorLoopRequests;
    const outputs: Array<{ type?: string; phase?: string; state?: string; message?: string }> = [];
    const runtime = await createProductionRuntime({
      workspace, home: workspace, environment: {}, approvalPolicy: "deny",
      output: (event) => outputs.push(event as typeof outputs[number]),
    });

    await runtime.session.start();
    await runtime.session.submit("/loop analyze the current project");

    expect(globalState.__flavorLoopRequests).toHaveLength(1);
    expect(JSON.stringify(globalState.__flavorLoopRequests)).toContain("Built-in Loop Skill");
    expect(outputs).toContainEqual(expect.objectContaining({
      type: "loop-progress", phase: "terminal", state: "completed",
    }));
    expect(outputs.find((event) => event.type === "loop-progress" && event.phase === "terminal")?.message)
      .toContain("succeeded");
    await runtime.dispose();
    delete globalState.__flavorLoopRequests;
  });

  it("asks again at each loop budget tranche", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "flavor-production-budget-")); roots.push(workspace);
    const pluginRoot = join(workspace, ".flavor", "plugins", "budget-model");
    await mkdir(pluginRoot, { recursive: true });
    await writeFile(join(workspace, "package.json"), JSON.stringify({
      name: "budget-fixture", private: true, scripts: { test: "node -e \"process.exit(1)\"" },
    }));
    await writeFile(join(workspace, ".flavor", "flavor.json"), JSON.stringify({
      providers: { capture: { type: "plugin", defaultModel: "main", cheapModel: "child" } },
      agents: { main: { model: "capture:main" }, subagent: { model: "capture:child" } },
      loop: { maxCycles: 1, maxTokens: 1000, isolation: "auto" },
    }));
    await writeFile(join(pluginRoot, "flavor-plugin.json"), JSON.stringify({
      name: "budget-model", version: "1.0.0", apiVersion: "1", main: "index.mjs", permissions: [],
      contributes: { commands: [], tools: [], hooks: [], skillRoots: [], modelAdapters: [{ name: "capture" }] },
    }));
    await writeFile(join(pluginRoot, "index.mjs"), `export function activate(ctx) {
      ctx.registerModelAdapter("capture", { async *stream() {
        yield { type: "text", text: "done" };
        yield { type: "done", usage: { inputTokens: 1, outputTokens: 1 } };
      }});
    }`);
    const outputs: Array<{ type?: string; phase?: string; message?: string }> = [];
    const runtime = await createProductionRuntime({
      workspace, home: workspace, environment: {},
      output: (event) => outputs.push(event as typeof outputs[number]),
    });

    const submission = runtime.session.submit("/loop analyze the current project");
    await vi.waitFor(() => expect(runtime.services.questions.pending?.[0]?.question).toContain("1 cycles"), { timeout: 5_000 });
    expect(runtime.services.questions.pending?.[0]?.question).toContain("2 cycles");
    expect(runtime.services.questions.pending?.[0]?.question).toContain("test failed with exit code 1");
    runtime.services.questions.answer({ 0: "Continue" });
    await vi.waitFor(() => expect(runtime.services.questions.pending?.[0]?.question).toContain("2 cycles"), { timeout: 5_000 });
    expect(runtime.services.questions.pending?.[0]?.question).toContain("3 cycles");
    runtime.services.questions.answer({ 0: "Stop" });
    await submission;

    expect(outputs.find((event) => event.phase === "terminal")?.message).toContain("budget_exhausted");
    await runtime.dispose();
  });

  it("uses a worker discovery cycle instead of exiting at zero tokens without a verifier", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "flavor-production-discovery-")); roots.push(workspace);
    const pluginRoot = join(workspace, ".flavor", "plugins", "discovery-model");
    await mkdir(pluginRoot, { recursive: true });
    await writeFile(join(workspace, ".flavor", "flavor.json"), JSON.stringify({
      providers: { capture: { type: "plugin", defaultModel: "main", cheapModel: "child" } },
      agents: { main: { model: "capture:main" }, subagent: { model: "capture:child" } },
    }));
    await writeFile(join(pluginRoot, "flavor-plugin.json"), JSON.stringify({
      name: "discovery-model", version: "1.0.0", apiVersion: "1", main: "index.mjs", permissions: [],
      contributes: { commands: [], tools: [], hooks: [], skillRoots: [], modelAdapters: [{ name: "capture" }] },
    }));
    await writeFile(join(pluginRoot, "index.mjs"), `export function activate(ctx) {
      ctx.registerModelAdapter("capture", { async *stream() {
        globalThis.__flavorDiscoveryCalls = (globalThis.__flavorDiscoveryCalls ?? 0) + 1;
        yield { type: "text", text: "done" };
        yield { type: "done", usage: { inputTokens: 7, outputTokens: 3 } };
      }});
    }`);
    const globalState = globalThis as typeof globalThis & { __flavorDiscoveryCalls?: number };
    delete globalState.__flavorDiscoveryCalls;
    const outputs: Array<{ type?: string; phase?: string; message?: string; usage?: { inputTokens: number; outputTokens: number } }> = [];
    const runtime = await createProductionRuntime({
      workspace, home: workspace, environment: {}, approvalPolicy: "deny",
      output: (event) => outputs.push(event as typeof outputs[number]),
    });

    await runtime.session.submit("/loop analyze and improve direction four");

    expect(globalState.__flavorDiscoveryCalls).toBe(1);
    expect(outputs.find((event) => event.phase === "resolved")?.message).toContain("discovery");
    expect(outputs.find((event) => event.phase === "terminal")?.message).toContain("needs_human");
    expect(outputs.find((event) => event.type === "done")?.usage).toEqual({ inputTokens: 7, outputTokens: 3 });
    await runtime.dispose();
    delete globalState.__flavorDiscoveryCalls;
  });

  it("restores a main plan and publishes its task snapshot at session start", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "flavor-production-")); roots.push(workspace);
    await mkdir(join(workspace, ".flavor"), { recursive: true });
    await writeFile(join(workspace, ".flavor", "flavor.json"), JSON.stringify({
      providers: { local: { type: "openai-compatible", baseURL: "http://127.0.0.1:1/v1", apiKey: "test-key", defaultModel: "large", cheapModel: "small" } },
    }));
    const store = new SessionStore({ workspace });
    await store.save({
      version: 4,
      sessionId: "planned-session",
      createdAt: "2026-07-13T01:00:00.000Z",
      updatedAt: "2026-07-13T01:01:00.000Z",
      workspace: { path: workspace },
      conversation: { messages: [
        { role: "user", content: "persist me" },
        { role: "assistant", content: "persisted answer" },
        { role: "tool", content: "hidden tool output", toolCallId: "call-1" },
      ] },
      tasks: {
        plan: { tasks: [{
          id: "inspect", subject: "Inspect code", activeForm: "Inspecting code",
          status: "pending", dependencies: [],
        }] },
        states: {},
        results: {},
      },
      models: { main: "local:large", subagent: "local:small" },
      permissionMode: "default",
      timeline: {
        version: 1,
        state: {
          completed: [{
            id: 1,
            prompt: "persist me",
            assistantText: "persisted answer",
            statusLines: ["✓ Read"],
            blocks: [
              { kind: "status", id: "tool:call-1", state: "completed", text: "✓ Read", tool: {
                name: "Read", input: { path: "a.ts" }, result: { ok: true, output: "hidden tool output" },
              } },
              { kind: "text", text: "persisted answer" },
            ],
          }],
          nextId: 2,
        },
      },
    });
    const outputs: unknown[] = [];
    const runtime = await createProductionRuntime({
      workspace, home: workspace, environment: {}, resumeSession: "planned-session",
      output: (event) => outputs.push(event),
    });

    await runtime.session.start();

    expect(runtime.restoredTranscript.completed[0]).toMatchObject({
      prompt: "persist me",
      blocks: [expect.objectContaining({
        id: "tool:call-1",
        tool: { name: "Read", input: { path: "a.ts" }, result: { ok: true, output: "hidden tool output" } },
      }), expect.objectContaining({ kind: "text", text: "persisted answer" })],
    });
    expect(runtime.services.tasks()).toMatchObject({ plan: { tasks: [{ id: "inspect" }] } });
    expect(outputs).toContainEqual(expect.objectContaining({
      type: "tasks",
      snapshot: expect.objectContaining({ plan: { tasks: [expect.objectContaining({ id: "inspect" })] } }),
    }));
    await runtime.dispose();
  });

  it("clears delegated state when TaskPlan replaces the main plan", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "flavor-production-replan-")); roots.push(workspace);
    const pluginRoot = join(workspace, ".flavor", "plugins", "replan-model");
    await mkdir(pluginRoot, { recursive: true });
    await writeFile(join(workspace, ".flavor", "flavor.json"), JSON.stringify({
      providers: { capture: { type: "plugin", defaultModel: "main", cheapModel: "child" } },
      agents: { main: { model: "capture:main" }, subagent: { model: "capture:child" } },
    }));
    await writeFile(join(pluginRoot, "flavor-plugin.json"), JSON.stringify({
      name: "replan-model", version: "1.0.0", apiVersion: "1", main: "index.mjs", permissions: [],
      contributes: { commands: [], tools: [], hooks: [], skillRoots: [], modelAdapters: [{ name: "capture" }] },
    }));
    await writeFile(join(pluginRoot, "index.mjs"), `export function activate(ctx) {
      let calls = 0;
      ctx.registerModelAdapter("capture", { async *stream() {
        if (calls++ === 0) {
          yield { type: "tool-call", id: "replace-plan", name: "TaskPlan", input: { tasks: [{
            id: "implement", subject: "Implement new requirement", activeForm: "Implementing new requirement",
            status: "pending", dependencies: [],
          }] } };
        } else {
          yield { type: "text", text: "done" };
        }
        yield { type: "done", usage: { inputTokens: 0, outputTokens: 0 } };
      }});
    }`);
    const store = new SessionStore({ workspace });
    await store.save({
      version: 4,
      sessionId: "old-plan-session",
      createdAt: "2026-07-19T01:00:00.000Z",
      updatedAt: "2026-07-19T01:01:00.000Z",
      workspace: { path: workspace },
      conversation: { messages: [] },
      tasks: {
        plan: { tasks: [{
          id: "inspect", subject: "Inspect old requirement", activeForm: "Inspecting old requirement",
          status: "completed", dependencies: [],
        }] },
        graph: { nodes: [{
          id: "old-worker", description: "Old delegated work", dependencies: [], expectedOutputs: [], verification: [],
        }] },
        states: { "old-worker": "completed" },
        results: { "old-worker": {
          taskId: "old-worker", status: "completed", summary: "old work complete",
          filesChanged: [], commandsRun: [], verification: [], artifacts: [], risks: [], suggestedNextSteps: [],
        } },
      },
      models: { main: "capture:main", subagent: "capture:child" },
      permissionMode: "default",
      timeline: { version: 1, state: { completed: [], nextId: 1 } },
    });
    const runtime = await createProductionRuntime({
      workspace, home: workspace, environment: {}, resumeSession: "old-plan-session",
      approvalPolicy: "deny", output: () => {},
    });

    await runtime.session.start();
    await runtime.session.submit("The requirement changed; replan it");

    expect(runtime.services.tasks()).toEqual({
      plan: undefined,
      graph: undefined,
      states: {},
      results: {},
    });
    await runtime.dispose();
    const persisted = await store.load("old-plan-session");
    expect(persisted.timeline.state.completed.at(-1)?.blocks).toContainEqual(expect.objectContaining({
      id: "tool:replace-plan",
      state: "completed",
      tool: expect.objectContaining({
        name: "TaskPlan",
        input: expect.objectContaining({ tasks: [expect.objectContaining({ id: "implement" })] }),
        result: expect.objectContaining({ ok: true }),
      }),
    }));
  });

  it("publishes a fresh plan when a new query follows an interrupted planned turn", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "flavor-production-interrupted-replan-")); roots.push(workspace);
    const pluginRoot = join(workspace, ".flavor", "plugins", "interrupted-replan-model");
    await mkdir(pluginRoot, { recursive: true });
    await writeFile(join(workspace, ".flavor", "flavor.json"), JSON.stringify({
      providers: { capture: { type: "plugin", defaultModel: "main", cheapModel: "child" } },
      agents: { main: { model: "capture:main" }, subagent: { model: "capture:child" } },
      memory: { enabled: false }, hallucination: { showWarnings: false }, sleep: false,
    }));
    await writeFile(join(pluginRoot, "flavor-plugin.json"), JSON.stringify({
      name: "interrupted-replan-model", version: "1.0.0", apiVersion: "1", main: "index.mjs", permissions: [],
      contributes: { commands: [], tools: [], hooks: [], skillRoots: [], modelAdapters: [{ name: "capture" }] },
    }));
    await writeFile(join(pluginRoot, "index.mjs"), `export function activate(ctx) {
      let phase = "first-plan";
      ctx.registerModelAdapter("capture", { async *stream(request) {
        if (phase === "first-plan") {
          phase = "first-wait";
          yield { type: "tool-call", id: "old-plan", name: "TaskPlan", input: { tasks: [{
            id: "old-work", subject: "Implement old query", activeForm: "Implementing old query",
            status: "pending", dependencies: [],
          }] } };
          yield { type: "done", usage: { inputTokens: 1, outputTokens: 1 } };
          return;
        }
        if (phase === "first-wait") {
          phase = "second-query";
          if (!request.signal.aborted) {
            await new Promise((resolve) => request.signal.addEventListener("abort", resolve, { once: true }));
          }
          yield { type: "error", error: { code: "cancelled", message: "cancelled by test" } };
          return;
        }
        if (phase === "second-query") {
          phase = "finish";
          const reset = request.messages.some((message) => message.role === "system"
            && String(message.content).includes("previous turn's task plan was cancelled"));
          if (reset) {
            yield { type: "tool-call", id: "fresh-plan", name: "TaskPlan", input: { tasks: [{
              id: "new-work", subject: "Implement revised query", activeForm: "Implementing revised query",
              status: "pending", dependencies: [],
            }] } };
          } else {
            yield { type: "tool-call", id: "stale-update", name: "TaskUpdate", input: {
              taskId: "old-work", status: "in_progress",
            } };
          }
          yield { type: "done", usage: { inputTokens: 1, outputTokens: 1 } };
          return;
        }
        yield { type: "text", text: "done" };
        yield { type: "done", usage: { inputTokens: 1, outputTokens: 1 } };
      }});
    }`);
    const outputs: unknown[] = [];
    const runtime = await createProductionRuntime({
      workspace, home: workspace, environment: {}, approvalPolicy: "deny",
      output: (event) => outputs.push(event),
    });

    const first = runtime.session.submit("implement the original multi-step query");
    await vi.waitFor(() => expect(outputs).toContainEqual(expect.objectContaining({
      type: "tasks",
      snapshot: expect.objectContaining({ plan: { tasks: [expect.objectContaining({ id: "old-work" })] } }),
    })));
    expect(runtime.session.interrupt()).toBe("cancelled");
    await first;
    await runtime.session.submit("/tasks");
    await runtime.session.submit("the requirement changed; implement the revised multi-step query");

    expect(outputs).toContainEqual(expect.objectContaining({
      type: "tasks",
      snapshot: expect.objectContaining({ plan: { tasks: [expect.objectContaining({ id: "new-work" })] } }),
    }));
    await runtime.dispose();
  });

  it("saves lifecycle state and resumes only when explicitly requested", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "flavor-production-")); roots.push(workspace);
    const pluginRoot = join(workspace, ".flavor", "plugins", "capture-lifecycle");
    await mkdir(pluginRoot, { recursive: true });
    await writeFile(join(workspace, ".flavor", "flavor.json"), JSON.stringify({
      providers: { capture: { type: "plugin", defaultModel: "main", cheapModel: "child" } },
      agents: { main: { model: "capture:main" }, subagent: { model: "capture:child" } },
    }));
    await writeFile(join(pluginRoot, "flavor-plugin.json"), JSON.stringify({
      name: "capture-lifecycle", version: "1.0.0", apiVersion: "1", main: "index.mjs", permissions: [],
      contributes: { commands: [], tools: [], hooks: [], skillRoots: [], modelAdapters: [{ name: "capture" }] },
    }));
    await writeFile(join(pluginRoot, "index.mjs"), `export function activate(ctx) {
      ctx.registerModelAdapter("capture", { async *stream() {
        yield { type: "text", text: "done" };
        yield { type: "done", usage: { inputTokens: 0, outputTokens: 0 } };
      }});
    }`);
    const first = await createProductionRuntime({ workspace, home: workspace, environment: {}, output: () => {} });
    await first.session.start();
    await first.services.setPermissionMode("acceptEdits");
    await first.session.submit("persist me");
    await first.session.close(); await first.dispose();
    const saved = await new SessionStore({ workspace }).load();
    expect(saved.conversation.messages.some((message) => message.role === "user" && message.content === "persist me")).toBe(true);
    expect(saved.timeline.state.completed.some((turn) => turn.prompt === "persist me")).toBe(true);
    expect(saved.permissionMode).toBe("acceptEdits");

    const fresh = await createProductionRuntime({ workspace, home: workspace, environment: {}, output: () => {} });
    expect(fresh.restoredTranscript).toEqual({ completed: [], nextId: 1 });
    expect(fresh.services.permissionMode()).toBe("default");
    await fresh.dispose();
    const resumed = await createProductionRuntime({ workspace, home: workspace, environment: {}, resumeSession: saved.sessionId, output: () => {} });
    expect(resumed.services.permissionMode()).toBe("acceptEdits");
    expect(resumed.sessionId).toBe(saved.sessionId);
    await resumed.dispose();
  });
  it("starts without credentials and returns actionable model setup output", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "flavor-production-")); roots.push(workspace);
    const output: string[] = [];
    const runtime = await createProductionRuntime({
      workspace, home: workspace, environment: {},
      output: (event) => { if (event.type === "error") output.push(event.error.message); },
    });
    await runtime.session.start();
    await runtime.session.submit("hello");
    await runtime.session.close();
    await runtime.dispose();
    expect(output.join("\n")).toContain(".flavor/flavor.json");
  });

  it("approval bridge waits for and resolves a UI decision", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "flavor-production-")); roots.push(workspace);
    const runtime = await createProductionRuntime({ workspace, home: workspace, environment: {}, output: () => {} });
    const pending = runtime.approvals.request({ agent: "main", tool: "Write", paths: [workspace] });
    expect(runtime.approvals.pending?.tool).toBe("Write");
    runtime.approvals.resolve("once");
    await expect(pending).resolves.toBe("once");
    await runtime.dispose();
  });

  it("cancels and clears a pending approval when its run aborts", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "flavor-production-")); roots.push(workspace);
    const runtime = await createProductionRuntime({ workspace, home: workspace, environment: {}, output: () => {} });
    const controller = new AbortController();
    const pending = runtime.approvals.request({ agent: "main", tool: "Write", paths: [workspace] }, controller.signal);
    controller.abort(new Error("cancel approval"));
    await expect(pending).resolves.toBe("deny");
    expect(runtime.approvals.pending).toBeUndefined();
    await runtime.dispose();
  });

  it("selects deterministic main and cheaper models from a configured provider", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "flavor-production-")); roots.push(workspace);
    await mkdir(join(workspace, ".flavor"), { recursive: true });
    await writeFile(join(workspace, ".flavor", "flavor.json"), JSON.stringify({
      providers: { local: { type: "openai-compatible", baseURL: "http://localhost:1234/v1", apiKey: "test-key", defaultModel: "large", cheapModel: "small" } },
    }));
    const runtime = await createProductionRuntime({ workspace, home: workspace, environment: {}, output: () => {} });
    expect(runtime.services.mainModel()).toBe("local:large");
    expect(runtime.services.subagentModel()).toBe("local:small");
    expect(runtime.services.config()).toMatchObject({
      context: {
        windowTokens: 200_000,
        reservedOutputTokens: 20_000,
        autoCompactBufferTokens: 13_000,
      },
    });
    await runtime.dispose();
  });

  it("requires an explicit cheap model for custom child agents", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "flavor-production-")); roots.push(workspace);
    await mkdir(join(workspace, ".flavor"), { recursive: true });
    await writeFile(join(workspace, ".flavor", "flavor.json"), JSON.stringify({
      providers: { local: { type: "openai-compatible", baseURL: "http://localhost:1234/v1", apiKey: "test-key", defaultModel: "large" } },
    }));
    const runtime = await createProductionRuntime({ workspace, home: workspace, environment: {}, output: () => {} });
    expect(runtime.services.subagentModel()).toContain("configure-cheap-model");
    expect(JSON.stringify(runtime.services.config())).toContain("requires cheapModel");
    await runtime.dispose();
  });

  it("uses an official cheaper default and never silently reuses the main model", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "flavor-production-")); roots.push(workspace);
    const runtime = await createProductionRuntime({ workspace, home: workspace,
      environment: { OPENAI_API_KEY: "test-key" }, output: () => {} });
    expect(runtime.services.mainModel()).toBe("openai:gpt-5");
    expect(runtime.services.subagentModel()).toBe("openai:gpt-5-mini");
    await runtime.dispose();
  });

  it("audits all five recoverable failures while exposing only the final error", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "flavor-production-")); roots.push(workspace);
    const pluginRoot = join(workspace, ".flavor", "plugins", "failing-model");
    await mkdir(pluginRoot, { recursive: true });
    await writeFile(join(workspace, ".flavor", "flavor.json"), JSON.stringify({
      providers: { failing: { type: "plugin", defaultModel: "main", cheapModel: "cheap" } },
      agents: { main: { model: "failing:main" }, subagent: { model: "failing:cheap" } },
    }));
    await writeFile(join(pluginRoot, "flavor-plugin.json"), JSON.stringify({
      name: "failing-model", version: "1.0.0", apiVersion: "1", main: "index.mjs", permissions: [],
      contributes: { commands: [], tools: [], hooks: [], skillRoots: [], modelAdapters: [{ name: "failing" }] },
    }));
    await writeFile(join(pluginRoot, "index.mjs"), `export function activate(ctx) {
      ctx.registerModelAdapter("failing", { async *stream(request) {
        globalThis.__flavorRetryModels ??= [];
        globalThis.__flavorRetryModels.push(request.model);
        yield { type: "error", error: {
          code: "network", message: "Upstream provider unreachable-" + globalThis.__flavorRetryModels.length,
        } };
      }});
    }`);
    const outputs: unknown[] = [];
    const runtime = await createProductionRuntime({
      workspace, home: workspace, environment: {}, output: (event) => outputs.push(event),
    });

    vi.useFakeTimers();
    try {
      const submission = runtime.session.submit("retry safely");
      await vi.runAllTimersAsync();
      await submission;
    } finally {
      vi.useRealTimers();
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect((globalThis as { __flavorRetryModels?: string[] }).__flavorRetryModels)
      .toEqual(["main", "main", "main", "cheap", "cheap"]);
    expect(outputs.filter((event): event is { type: "error"; error: { message: string } } =>
      typeof event === "object" && event !== null && (event as { type?: string }).type === "error"))
      .toEqual([{ type: "error", error: { code: "network", message: "Upstream provider unreachable-5" } }]);
    expect(JSON.stringify(outputs.filter((event) =>
      typeof event === "object" && event !== null && (event as { type?: string }).type === "model-retry")))
      .not.toContain("Upstream provider unreachable-");

    const auditEntries = (await readFile(join(workspace, ".flavor", "audit.jsonl"), "utf8"))
      .trim().split("\n").map((line) => JSON.parse(line));
    expect(auditEntries).toHaveLength(5);
    expect(auditEntries.map(({ attempt, maxAttempts }) => ({ attempt, maxAttempts }))).toEqual([
      { attempt: 1, maxAttempts: 5 }, { attempt: 2, maxAttempts: 5 },
      { attempt: 3, maxAttempts: 5 }, { attempt: 4, maxAttempts: 5 },
      { attempt: 5, maxAttempts: 5 },
    ]);

    await runtime.dispose();
    delete (globalThis as { __flavorRetryModels?: string[] }).__flavorRetryModels;
  });

  it("activates, dispatches, and unloads a validated plugin command", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "flavor-production-")); roots.push(workspace);
    const root = join(workspace, ".flavor", "plugins", "taste"); await mkdir(root, { recursive: true });
    await writeFile(join(root, "flavor-plugin.json"), JSON.stringify({
      name: "taste", version: "1.0.0", apiVersion: "1", main: "index.mjs", permissions: [],
      contributes: { commands: [{ name: "taste" }], tools: [], hooks: [], skillRoots: [], modelAdapters: [] },
    }));
    await writeFile(join(root, "index.mjs"), `export function activate(ctx) {
      ctx.registerCommand("taste", (args) => ({ joined: args.join("+") }));
      return () => { globalThis.tasteUnloaded = true; };
    }`);
    const output: string[] = [];
    const runtime = await createProductionRuntime({ workspace, home: workspace, environment: {},
      output: (event) => { if (event.type === "notice") output.push(event.message); } });
    await runtime.session.start(); await runtime.session.submit("/taste saffron plum");
    expect(output.join("\n")).toContain("saffron+plum");
    await runtime.dispose();
    expect((globalThis as Record<string, unknown>).tasteUnloaded).toBe(true);
    delete (globalThis as Record<string, unknown>).tasteUnloaded;
  });

  it("disposes the main harness idempotently", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "flavor-production-")); roots.push(workspace);
    const runtime = await createProductionRuntime({ workspace, home: workspace, environment: {}, output: () => {} });
    await runtime.dispose(); await runtime.dispose();
    await expect(runtime.services.run("late", new AbortController().signal)[Symbol.asyncIterator]().next())
      .resolves.toMatchObject({ value: { type: "error" } });
  });

  it("rolls back activated plugins when contributed tool schema breaks bootstrap", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "flavor-production-")); roots.push(workspace);
    const root = join(workspace, ".flavor", "plugins", "broken-tool"); await mkdir(root, { recursive: true });
    await writeFile(join(root, "flavor-plugin.json"), JSON.stringify({
      name: "broken-tool", version: "1.0.0", apiVersion: "1", main: "index.mjs", permissions: [],
      contributes: { commands: [], tools: [{ name: "Broken" }], hooks: [], skillRoots: [], modelAdapters: [] },
    }));
    await writeFile(join(root, "index.mjs"), `export function activate(ctx) {
      ctx.registerTool("Broken", { name: "Broken", description: "bad", inputSchema: {}, paths: () => [], execute: async () => null });
      return () => { globalThis.brokenToolDisposed = true; };
    }`);
    await expect(createProductionRuntime({ workspace, home: workspace, environment: {}, output: () => {} })).rejects.toThrow();
    expect((globalThis as Record<string, unknown>).brokenToolDisposed).toBe(true);
    delete (globalThis as Record<string, unknown>).brokenToolDisposed;
  });

  it("hot-loads a registered tool in the same run and restores it after restart", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "flavor-production-managed-tool-")); roots.push(workspace);
    const pluginRoot = join(workspace, ".flavor", "plugins", "managed-tool-model");
    await mkdir(pluginRoot, { recursive: true });
    await writeFile(join(workspace, ".flavor", "flavor.json"), JSON.stringify({
      permissionMode: "bypassPermissions",
      providers: { capture: { type: "plugin", defaultModel: "main", cheapModel: "child" } },
      agents: { main: { model: "capture:main" }, subagent: { model: "capture:child" } },
    }));
    await writeFile(join(pluginRoot, "flavor-plugin.json"), JSON.stringify({
      name: "managed-tool-model", version: "1.0.0", apiVersion: "1", main: "index.mjs", permissions: [],
      contributes: { commands: [], tools: [], hooks: [], skillRoots: [], modelAdapters: [{ name: "capture" }] },
    }));
    await writeFile(join(pluginRoot, "index.mjs"), `export function activate(ctx) {
      ctx.registerModelAdapter("capture", { async *stream(request) {
        globalThis.__flavorManagedSnapshots ??= [];
        globalThis.__flavorManagedSnapshots.push(request.tools.map((tool) => tool.name));
        if (globalThis.__flavorManagedRestart === true) {
          yield { type: "text", text: "done" };
          yield { type: "done", usage: { inputTokens: 1, outputTokens: 1 } };
          return;
        }
        const call = globalThis.__flavorManagedSnapshots.length;
        if (call === 1) {
          yield { type: "tool-call", id: "register-1", name: "RegisterTool", input: {
            name: "EchoUpper",
            description: "Uppercase text",
            inputSchema: {
              type: "object",
              properties: { text: { type: "string" } },
              required: ["text"],
              additionalProperties: false,
            },
            implementation: "async (input) => ({ value: input.text.toUpperCase() })",
            scope: "project",
            agents: ["main"],
          }};
        } else if (call === 2) {
          yield { type: "tool-call", id: "echo-1", name: "EchoUpper", input: { text: "flavor" } };
        } else {
          globalThis.__flavorManagedResult = request.messages.findLast((message) => message.role === "tool")?.content;
          yield { type: "text", text: "done" };
        }
        yield { type: "done", usage: { inputTokens: 1, outputTokens: 1 } };
      }});
    }`);
    const state = globalThis as typeof globalThis & {
      __flavorManagedSnapshots?: string[][];
      __flavorManagedResult?: string;
      __flavorManagedRestart?: boolean;
    };
    delete state.__flavorManagedSnapshots;
    delete state.__flavorManagedResult;
    delete state.__flavorManagedRestart;

    const first = await createProductionRuntime({ workspace, home: workspace, environment: {}, output: () => {} });
    const firstSubmission = first.session.submit("create and use a reusable uppercase tool");
    await vi.waitFor(() => expect(first.approvals.pending?.tool).toBe("EchoUpper"));
    first.approvals.resolve("once");
    await firstSubmission;
    expect(state.__flavorManagedSnapshots).toHaveLength(3);
    expect(state.__flavorManagedSnapshots?.[0]).toContain("RegisterTool");
    expect(state.__flavorManagedSnapshots?.[0]).not.toContain("EchoUpper");
    expect(state.__flavorManagedSnapshots?.[1]).toContain("EchoUpper");
    expect(state.__flavorManagedResult).toContain("FLAVOR");
    expect(JSON.parse(await readFile(
      join(workspace, ".flavor", "tools", "echoupper.json"), "utf8",
    ))).toMatchObject({ name: "EchoUpper" });
    await first.dispose();

    state.__flavorManagedRestart = true;
    state.__flavorManagedSnapshots = [];
    const restarted = await createProductionRuntime({ workspace, home: workspace, environment: {}, output: () => {} });
    await restarted.session.submit("show available tools");
    expect(state.__flavorManagedSnapshots?.[0]).toContain("EchoUpper");
    await restarted.dispose();
    delete state.__flavorManagedSnapshots;
    delete state.__flavorManagedResult;
    delete state.__flavorManagedRestart;
  });
});
