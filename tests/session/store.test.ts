import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { ContextManager } from "../../src/context/manager.js";
import { HookBus } from "../../src/hooks/bus.js";
import { SessionStore, type SessionDocument } from "../../src/session/store.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "flavor-session-")); roots.push(root); return root;
}

function document(root: string): SessionDocument {
  return {
    version: 2,
    sessionId: "session-20260712",
    createdAt: "2026-07-12T01:00:00.000Z",
    updatedAt: "2026-07-12T02:00:00.000Z",
    workspace: { path: root },
    conversation: { messages: [{ role: "user", content: "hello" }, { role: "assistant", content: "world" }] },
    tasks: {
      graph: { nodes: [{ id: "a", description: "A", dependencies: [], expectedOutputs: ["a"], verification: ["ok"] }] },
      states: { a: "completed" },
      results: { a: { taskId: "a", status: "completed", summary: "done", filesChanged: [], commandsRun: [], verification: [], artifacts: [], risks: [], suggestedNextSteps: [] } },
    },
    models: { main: "local:large", subagent: "local:small" },
    permissionMode: "default",
  };
}

describe("SessionStore", () => {
  it("deletes one saved session without touching the remaining history", async () => {
    const root = await workspace();
    const store = new SessionStore({ workspace: root });
    await store.save(document(root));
    await store.save({ ...document(root), sessionId: "keep-session" });

    await store.delete("session-20260712");

    await expect(store.load("session-20260712")).rejects.toThrow(/not found/i);
    await expect(store.list()).resolves.toEqual([
      expect.objectContaining({ sessionId: "keep-session" }),
    ]);
  });

  it("rejects traversal when deleting a session", async () => {
    const root = await workspace();
    const store = new SessionStore({ workspace: root });

    await expect(store.delete("../outside")).rejects.toThrow(/session id/i);
  });

  it("persists a main plan and cancels abandoned in-progress work on load", async () => {
    const root = await workspace();
    const store = new SessionStore({ workspace: root });
    const saved = document(root);
    saved.tasks.plan = { tasks: [{
      id: "inspect",
      subject: "Inspect code",
      activeForm: "Inspecting code",
      status: "in_progress",
      dependencies: [],
    }] };

    await store.save(saved);

    expect((await store.load(saved.sessionId)).tasks.plan?.tasks[0]).toMatchObject({
      status: "cancelled",
      result: "Execution was abandoned",
    });
  });

  it("loads a version-2 document without a main plan", async () => {
    const root = await workspace();
    const store = new SessionStore({ workspace: root });
    await store.save(document(root));

    expect((await store.load("session-20260712")).tasks.plan).toBeUndefined();
  });

  it("round-trips a cancelled subagent state without synthesizing a result", async () => {
    const root = await workspace();
    const store = new SessionStore({ workspace: root });
    const saved = document(root);
    saved.tasks.states.a = "cancelled";
    saved.tasks.results = {};

    await store.save(saved);

    expect((await store.load(saved.sessionId)).tasks).toMatchObject({
      states: { a: "cancelled" },
      results: {},
    });
  });

  it("writes each message as a separate JSONL line with a metadata header", async () => {
    const root = await workspace();
    const store = new SessionStore({ workspace: root });
    await store.save(document(root));

    const raw = await readFile(join(root, ".flavor", "sessions", "session-20260712.jsonl"), "utf8");
    const lines = raw.trim().split("\n").filter((line) => line.length > 0);
    expect(lines.length).toBe(3); // metadata + 2 messages

    const meta = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(meta.__meta).toBe(true);
    expect(meta.version).toBe(2);
    expect(meta.sessionId).toBe("session-20260712");
    expect(meta).not.toHaveProperty("conversation");

    const msg1 = JSON.parse(lines[1]!) as Record<string, unknown>;
    expect(msg1).toMatchObject({ role: "user", content: "hello" });

    const msg2 = JSON.parse(lines[2]!) as Record<string, unknown>;
    expect(msg2).toMatchObject({ role: "assistant", content: "world" });

    // Round-trip
    const loaded = await store.load("session-20260712");
    expect(loaded.conversation.messages).toEqual([
      { role: "user", content: "hello" },
      { role: "assistant", content: "world" },
    ]);
  });

  it("preserves the compact boundary in the metadata line", async () => {
    const root = await workspace();
    const store = new SessionStore({ workspace: root });
    const doc = document(root);
    doc.conversation.compact = { summary: "Test summary.", compactedAt: "2026-07-12T01:30:00.000Z" };

    await store.save(doc);

    const raw = await readFile(join(root, ".flavor", "sessions", "session-20260712.jsonl"), "utf8");
    const meta = JSON.parse(raw.trim().split("\n")[0]!) as Record<string, unknown>;
    expect(meta.compact).toEqual({ summary: "Test summary.", compactedAt: "2026-07-12T01:30:00.000Z" });
    expect(meta).not.toHaveProperty("summary");

    const loaded = await store.load("session-20260712");
    expect(loaded.conversation.compact).toEqual({ summary: "Test summary.", compactedAt: "2026-07-12T01:30:00.000Z" });
  });

  it("loads old single-line JSON format for backward compatibility", async () => {
    const root = await workspace();
    await mkdir(join(root, ".flavor", "sessions"), { recursive: true });
    const oldDoc = {
      version: 1,
      sessionId: "old-format",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T01:00:00.000Z",
      workspace: { path: root },
      conversation: {
        summary: { role: "system", content: "Conversation summary\nOld summary." },
        messages: [
          { role: "user", content: "old question" },
          { role: "assistant", content: "old answer", toolCalls: [{ id: "t1", name: "Read", input: { path: "x" } }] },
          { role: "tool", toolCallId: "t1", content: "file contents" },
          { role: "assistant", content: "follow-up" },
        ],
      },
      tasks: { states: {}, results: {} },
      models: { main: "openai:gpt-5", subagent: "openai:gpt-5-mini" },
      permissionMode: "workspace",
    };
    await writeFile(
      join(root, ".flavor", "sessions", "old-format.jsonl"),
      `${JSON.stringify(oldDoc)}\n`,
      "utf8",
    );

    const store = new SessionStore({ workspace: root });
    const loaded = await store.load("old-format");
    expect(loaded.sessionId).toBe("old-format");
    expect(loaded.version).toBe(2);
    expect(loaded.conversation.compact).toEqual({ summary: "Old summary.", compactedAt: "2026-01-01T01:00:00.000Z" });
    expect(loaded.conversation.messages).toHaveLength(4);
    expect(loaded.conversation.messages[1]).toMatchObject({
      role: "assistant",
      content: "old answer",
      toolCalls: [{ id: "t1", name: "Read", input: { path: "x" } }],
    });
  });

  it("migrates version-1 JSONL summary metadata to a compact boundary", async () => {
    const root = await workspace();
    await mkdir(join(root, ".flavor", "sessions"), { recursive: true });
    const meta = {
      __meta: true,
      version: 1,
      sessionId: "old-jsonl",
      createdAt: "2026-02-01T00:00:00.000Z",
      updatedAt: "2026-02-01T01:00:00.000Z",
      workspace: { path: root },
      tasks: { states: {}, results: {} },
      models: { main: "openai:gpt-5", subagent: "openai:gpt-5-mini" },
      permissionMode: "workspace",
      summary: { role: "system", content: "Conversation summary\nJSONL summary." },
    };
    await writeFile(join(root, ".flavor", "sessions", "old-jsonl.jsonl"), [
      JSON.stringify(meta),
      JSON.stringify({ role: "user", content: "continue" }),
      "",
    ].join("\n"));

    const loaded = await new SessionStore({ workspace: root }).load("old-jsonl");

    expect(loaded.version).toBe(2);
    expect(loaded.conversation.compact).toEqual({ summary: "JSONL summary.", compactedAt: "2026-02-01T01:00:00.000Z" });
    expect(loaded.conversation.messages).toEqual([{ role: "user", content: "continue" }]);
  });

  it("atomically saves a strict, secret-free document and lists deterministically", async () => {
    const root = await workspace();
    const store = new SessionStore({ workspace: root });
    const sensitive = document(root);
    sensitive.conversation.messages.push({ role: "assistant", content: "authorization: Bearer hidden-token", toolCalls: [
      { id: "secret-call", name: "Fetch", input: { apiKey: "sk-secret", headers: { Authorization: "Bearer hidden" } } },
    ] });
    await store.save(sensitive);
    const older = { ...document(root), sessionId: "older", createdAt: "2026-07-11T01:00:00.000Z", updatedAt: "2026-07-11T02:00:00.000Z" };
    await store.save(older);

    const entries = await readdir(join(root, ".flavor", "sessions"));
    expect(entries).toEqual(expect.arrayContaining(["session-20260712.jsonl", "older.jsonl"]));
    expect(entries.every((entry) => !entry.includes(".tmp"))).toBe(true);
    const stored = await readFile(join(root, ".flavor", "sessions", "session-20260712.jsonl"), "utf8");
    expect(stored).not.toMatch(/apiKey|authorization|sk-secret|hidden-token/i);
    expect(await store.list()).toEqual([
      expect.objectContaining({ sessionId: "session-20260712" }),
      expect.objectContaining({ sessionId: "older" }),
    ]);
    await expect(store.load()).resolves.toMatchObject({ sessionId: "session-20260712" });
  });

  it("quarantines corrupt files without crashing latest lookup", async () => {
    const root = await workspace();
    const store = new SessionStore({ workspace: root });
    await store.save(document(root));
    await writeFile(join(root, ".flavor", "sessions", "broken.jsonl"), "{not json", "utf8");

    await expect(store.load("broken")).rejects.toThrow(/corrupt|quarantined/i);
    await expect(store.load()).resolves.toMatchObject({ sessionId: "session-20260712" });
    expect((await readdir(join(root, ".flavor", "sessions"))).some((name) => name.startsWith("broken.jsonl.corrupt-"))).toBe(true);
  });

  it("rejects oversized reads, traversal ids, incompatible versions, workspaces, and symlink session roots", async () => {
    const root = await workspace();
    const store = new SessionStore({ workspace: root, maxBytes: 256 });
    await mkdir(join(root, ".flavor", "sessions"), { recursive: true });
    await writeFile(join(root, ".flavor", "sessions", "huge.jsonl"), "x".repeat(257));
    await expect(store.load("huge")).rejects.toThrow(/size/i);
    await expect(store.load("../outside")).rejects.toThrow(/session id/i);

    const other = await workspace();
    const normal = new SessionStore({ workspace: root });
    await expect(normal.save({ ...document(root), workspace: { path: other } })).rejects.toThrow(/workspace/i);
    await mkdir(join(root, ".flavor"), { recursive: true });
    await rm(join(root, ".flavor", "sessions"), { recursive: true, force: true });
    await symlink(other, join(root, ".flavor", "sessions"), process.platform === "win32" ? "junction" : "dir");
    expect((await lstat(join(root, ".flavor", "sessions"))).isSymbolicLink()).toBe(true);
    await expect(normal.save(document(root))).rejects.toThrow(/symbolic link/i);
  });
});

describe("ContextManager recovery", () => {
  it("restores only provider-valid conversation turns while retaining current pinned instructions", () => {
    const source = context("old-system", "old-flavor");
    source.appendMany([
      { role: "user", content: "question" },
      { role: "assistant", content: "", toolCalls: [{ id: "call", name: "Read", input: { path: "a" } }] },
      { role: "tool", toolCallId: "call", content: "result" },
      { role: "assistant", content: "answer" },
    ]);
    const snapshot = source.snapshot();
    const restored = context("new-system", "new-flavor");
    restored.restore(snapshot);

    expect(restored.messagesForModel().map((message) => message.content)).toEqual([
      "new-system", "FLAVOR.md\nnew-flavor", "question", "", "result", "answer",
    ]);
    restored.restore({ messages: [
      { role: "system", content: "injected" },
      { role: "tool", toolCallId: "missing", content: "orphan" },
      { role: "assistant", content: "safe" },
    ] });
    expect(restored.messagesForModel().map((message) => message.content)).toEqual(["new-system", "FLAVOR.md\nnew-flavor", "safe"]);
  });
});

function context(system: string, flavor: string): ContextManager {
  return new ContextManager({ system, flavor, compactAtChars: 10_000, toolOutputChars: 1_000,
    summarize: async () => "summary", hooks: new HookBus() });
}
