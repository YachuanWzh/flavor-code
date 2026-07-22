import { describe, expect, it } from "vitest";

import {
  AnswerQuestionsInputSchema,
  AppMenuInputSchema,
  DeleteSessionInputSchema,
  DeleteMemoryInputSchema,
  MemoryCandidateInputSchema,
  McpServerNameInputSchema,
  SaveMcpServerInputSchema,
  OpenWorkspaceInputSchema,
  ResolveApprovalInputSchema,
  StartSessionInputSchema,
  SkillDraftInputSchema,
  SkillNameInputSchema,
  SetSkillEnabledInputSchema,
  SubmitInputSchema,
  UpdateMemoryInputSchema,
} from "../../src/desktop/contracts.js";

describe("desktop IPC contracts", () => {
  it("accepts the bounded request payloads used by the preload bridge", () => {
    expect(OpenWorkspaceInputSchema.parse({ path: "C:\\work\\demo" })).toEqual({ path: "C:\\work\\demo" });
    expect(StartSessionInputSchema.parse({ resumeSession: "session-1" })).toEqual({ resumeSession: "session-1" });
    expect(SubmitInputSchema.parse({ prompt: "fix the tests" })).toEqual({ prompt: "fix the tests" });
    expect(ResolveApprovalInputSchema.parse({ decision: "allow" })).toEqual({ decision: "allow" });
    expect(ResolveApprovalInputSchema.parse({ decision: "always" })).toEqual({ decision: "always" });
    expect(AnswerQuestionsInputSchema.parse({ answers: { 0: "Electron" } })).toEqual({ answers: { 0: "Electron" } });
    expect(DeleteSessionInputSchema.parse({ sessionId: "session-1" })).toEqual({ sessionId: "session-1" });
    expect(AppMenuInputSchema.parse({ menu: "file", x: 12, y: 36 })).toEqual({ menu: "file", x: 12, y: 36 });
    expect(SkillNameInputSchema.parse({ name: "code-review" })).toEqual({ name: "code-review" });
    expect(SkillDraftInputSchema.parse({ name: "code-review", description: "Review code", body: "Instructions" }))
      .toEqual({ name: "code-review", description: "Review code", body: "Instructions", disableModelInvocation: false });
    expect(SetSkillEnabledInputSchema.parse({ name: "code-review", enabled: false })).toEqual({ name: "code-review", enabled: false });
    expect(MemoryCandidateInputSchema.parse({ type: "project", content: "Use pnpm." }))
      .toEqual({ type: "project", content: "Use pnpm." });
    expect(UpdateMemoryInputSchema.parse({ id: "abcdef123456", type: "feedback", content: "Do not commit." }))
      .toEqual({ id: "abcdef123456", type: "feedback", content: "Do not commit." });
    expect(DeleteMemoryInputSchema.parse({ id: "abcdef123456" })).toEqual({ id: "abcdef123456" });
    expect(McpServerNameInputSchema.parse({ name: "remote_docs" })).toEqual({ name: "remote_docs" });
    expect(SaveMcpServerInputSchema.parse({
      draft: { name: "local", config: { command: "node", args: ["server.mjs"] } },
    })).toEqual({ draft: { name: "local", config: {
      command: "node", args: ["server.mjs"], env: {}, disabled: false, timeoutMs: 60_000,
    } } });
    expect(SaveMcpServerInputSchema.parse({
      originalName: "docs", draft: { name: "docs", config: { url: "https://mcp.example.com/mcp" } },
    })).toMatchObject({ originalName: "docs", draft: { name: "docs", config: { url: "https://mcp.example.com/mcp" } } });
  });

  it("rejects blank prompts, unknown approval decisions and oversized question indexes", () => {
    expect(() => SubmitInputSchema.parse({ prompt: "   " })).toThrow();
    expect(() => ResolveApprovalInputSchema.parse({ decision: "never" })).toThrow();
    expect(() => AnswerQuestionsInputSchema.parse({ answers: { 10: "x" } })).toThrow();
    expect(() => DeleteSessionInputSchema.parse({ sessionId: "../outside" })).toThrow();
    expect(() => AppMenuInputSchema.parse({ menu: "window", x: -1, y: 36 })).toThrow();
    expect(() => SkillNameInputSchema.parse({ name: "../escape" })).toThrow();
    expect(() => MemoryCandidateInputSchema.parse({ type: "secret", content: "x" })).toThrow();
    expect(() => UpdateMemoryInputSchema.parse({ id: "../outside", type: "project", content: "x" })).toThrow();
    expect(() => McpServerNameInputSchema.parse({ name: "../outside" })).toThrow();
    expect(() => SaveMcpServerInputSchema.parse({
      draft: { name: "mixed", config: { command: "node", url: "https://example.com" } },
    })).toThrow();
    expect(() => SaveMcpServerInputSchema.parse({
      draft: { name: "ftp", config: { url: "ftp://example.com/mcp" } },
    })).toThrow();
  });
});
