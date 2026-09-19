import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";

import { registerSessionCommands, type SessionCliStore } from "../../src/session/cli.js";
import type { SessionDocument, SessionEntry } from "../../src/session/store.js";

function entry(sessionId: string, mainModel: string, updatedAt: string): SessionEntry {
  return { sessionId, createdAt: "2026-09-01T00:00:00Z", updatedAt, mainModel };
}

function makeDocument(overrides: Partial<SessionDocument> = {}): SessionDocument {
  const completed = [
    { id: 1, prompt: "Fix the login bug", assistantText: "Patched auth/store.ts", statusLines: [], blocks: [] },
    { id: 2, prompt: "Add tests", assistantText: "Added 3 cases", statusLines: [], blocks: [] },
  ];
  return {
    sessionId: "sess-1",
    createdAt: "2026-09-01T00:00:00Z",
    updatedAt: "2026-09-02T00:00:00Z",
    workspace: { path: "C:\\work" },
    models: { main: "openai:gpt-5", subagent: "anthropic:claude" },
    permissionMode: "default",
    conversation: { messages: [{ role: "user", content: "hi" }] },
    timeline: { version: 1, state: { completed, nextId: 3 } },
    ...overrides,
  } as unknown as SessionDocument;
}

function harness(store: Partial<SessionCliStore>) {
  const output: string[] = [];
  const program = new Command().exitOverride();
  registerSessionCommands(program, {
    open: () => store as SessionCliStore,
    cwd: () => "C:\\work",
    write: (text) => output.push(text),
  });
  return { program, output: () => output.join("") };
}

describe("flavor sessions CLI", () => {
  it("lists sessions in human and JSON formats", async () => {
    const list = vi.fn(async () => [entry("sess-2", "openai:gpt-5", "2026-09-03T00:00:00Z"), entry("sess-1", "anthropic:claude", "2026-09-02T00:00:00Z")]);
    const { program, output } = harness({ list });

    await program.parseAsync(["node", "flavor", "sessions", "list"]);
    expect(output()).toContain("sess-2  openai:gpt-5");
    expect(output()).toContain("sess-1  anthropic:claude");

    const json = harness({ list });
    await json.program.parseAsync(["node", "flavor", "sessions", "list", "--json"]);
    expect(JSON.parse(json.output())).toEqual([
      expect.objectContaining({ sessionId: "sess-2" }),
      expect.objectContaining({ sessionId: "sess-1" }),
    ]);
  });

  it("prints a friendly message when no sessions exist", async () => {
    const { program, output } = harness({ list: async () => [] });
    await program.parseAsync(["node", "flavor", "sessions", "list"]);
    expect(output()).toContain("No saved sessions");
  });

  it("shows a session summary", async () => {
    const { program, output } = harness({ load: async () => makeDocument() });
    await program.parseAsync(["node", "flavor", "sessions", "show", "sess-1"]);
    expect(output()).toContain("Session sess-1");
    expect(output()).toContain("turns: 2");
    expect(output()).toContain("first prompt: Fix the login bug");
  });

  it("exports a markdown transcript and a JSON document", async () => {
    const md = harness({ load: async () => makeDocument() });
    await md.program.parseAsync(["node", "flavor", "sessions", "export", "sess-1", "--format", "md"]);
    expect(md.output()).toContain("# Session sess-1");
    expect(md.output()).toContain("## Add tests");
    expect(md.output()).toContain("Added 3 cases");

    const json = harness({ load: async () => makeDocument() });
    await json.program.parseAsync(["node", "flavor", "sessions", "export", "sess-1", "--format", "json"]);
    expect(JSON.parse(json.output())).toMatchObject({ sessionId: "sess-1" });
  });

  it("rejects an unsupported export format before loading", async () => {
    const load = vi.fn(async () => makeDocument());
    const { program } = harness({ load });
    await expect(program.parseAsync(["node", "flavor", "sessions", "export", "sess-1", "--format", "yaml"])).rejects.toThrow(/Unsupported export format/i);
    expect(load).not.toHaveBeenCalled();
  });

  it("deletes a session and prints the directory path", async () => {
    const del = vi.fn(async () => undefined);
    const { program, output } = harness({ delete: del });
    await program.parseAsync(["node", "flavor", "sessions", "delete", "sess-1"]);
    expect(del).toHaveBeenCalledWith("sess-1");
    expect(output()).toContain("Deleted session sess-1");

    const path = harness({});
    await path.program.parseAsync(["node", "flavor", "sessions", "path"]);
    expect(path.output().trim()).toBe("C:\\work\\.flavor\\sessions");
  });
});
