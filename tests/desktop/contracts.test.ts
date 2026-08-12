import { describe, expect, it } from "vitest";

import {
  AnswerQuestionsInputSchema,
  AppMenuInputSchema,
  D2cGetReportInputSchema,
  D2cImportInputSchema,
  D2cReviewInputSchema,
  D2cConfirmMappingInputSchema,
  D2cTaskActionInputSchema,
  D2cManualAcceptanceInputSchema,
  D2cJudgeConfigInputSchema,
  DeleteSessionInputSchema,
  DeleteMemoryInputSchema,
  MemoryCandidateInputSchema,
  McpServerNameInputSchema,
  SaveMcpServerInputSchema,
  OpenWorkspaceInputSchema,
  ResolveApprovalInputSchema,
  ResolveMemoryReviewInputSchema,
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
    expect(SubmitInputSchema.parse({ prompt: "build from design", permissionProfile: "d2c" }))
      .toEqual({ prompt: "build from design", permissionProfile: "d2c" });
    expect(SubmitInputSchema.parse({
      prompt: "",
      attachments: [{ name: "screen.png", mediaType: "image/png", dataBase64: "iVBORw0KGgo=" }],
    })).toEqual({
      prompt: "",
      attachments: [{ name: "screen.png", mediaType: "image/png", dataBase64: "iVBORw0KGgo=" }],
    });
    expect(ResolveApprovalInputSchema.parse({ decision: "allow" })).toEqual({ decision: "allow" });
    expect(ResolveApprovalInputSchema.parse({ decision: "always" })).toEqual({ decision: "always" });
    expect(AnswerQuestionsInputSchema.parse({ answers: { 0: "Electron" } })).toEqual({ answers: { 0: "Electron" } });
    expect(ResolveMemoryReviewInputSchema.parse({ id: "memory-review-1", decision: "accept" }))
      .toEqual({ id: "memory-review-1", decision: "accept" });
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
    expect(() => SubmitInputSchema.parse({ prompt: "build", permissionProfile: "unrestricted" })).toThrow();
    expect(() => SubmitInputSchema.parse({ prompt: "build", delivery: "steer", permissionProfile: "d2c" })).toThrow();
    expect(() => SubmitInputSchema.parse({
      prompt: "look",
      delivery: "steer",
      attachments: [{ name: "x.png", mediaType: "image/png", dataBase64: "iVBORw0KGgo=" }],
    })).toThrow();
    expect(() => SubmitInputSchema.parse({
      prompt: "look",
      attachments: Array.from({ length: 6 }, (_, index) => ({
        name: `${index}.png`, mediaType: "image/png", dataBase64: "iVBORw0KGgo=",
      })),
    })).toThrow();
    expect(() => ResolveApprovalInputSchema.parse({ decision: "never" })).toThrow();
    expect(() => AnswerQuestionsInputSchema.parse({ answers: { 10: "x" } })).toThrow();
    expect(() => ResolveMemoryReviewInputSchema.parse({ id: "../outside", decision: "accept" })).toThrow();
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

describe("D2C IPC contracts", () => {
  it("accepts well-formed task and report references", () => {
    expect(D2cImportInputSchema.parse({ task: "homepage" })).toEqual({ task: "homepage" });
    expect(D2cGetReportInputSchema.parse({ task: "homepage" })).toEqual({ task: "homepage" });
    expect(D2cGetReportInputSchema.parse({ task: "homepage", reportId: "run-20260809-100000" }))
      .toEqual({ task: "homepage", reportId: "run-20260809-100000" });
    expect(D2cReviewInputSchema.parse({ task: "homepage", reportId: "run-20260809-100000",
      fingerprints: ["issue-card"], decision: "needs-fix", instruction: "收紧间距" }))
      .toEqual({ task: "homepage", reportId: "run-20260809-100000", fingerprints: ["issue-card"], decision: "needs-fix", instruction: "收紧间距" });
    expect(D2cConfirmMappingInputSchema.parse({ task: "homepage", moduleId: "stats", operationKey: "GET /metrics" }))
      .toEqual({ task: "homepage", moduleId: "stats", operationKey: "GET /metrics" });
    expect(D2cTaskActionInputSchema.parse({ task: "homepage" })).toEqual({ task: "homepage" });
    expect(D2cManualAcceptanceInputSchema.parse({ task: "homepage", accepted: true })).toEqual({ task: "homepage", accepted: true });
    expect(D2cJudgeConfigInputSchema.parse({ protocol: "openai-compatible", baseURL: "https://judge.example.com/v1",
      apiKey: "secret", model: "vision-pro", passThreshold: 85 })).toMatchObject({ model: "vision-pro", passThreshold: 85 });
  });

  it("rejects malformed task names and unknown fields", () => {
    expect(() => D2cImportInputSchema.parse({ task: "Upper Case" })).toThrow();
    expect(() => D2cImportInputSchema.parse({ task: "-leading-dash" })).toThrow();
    expect(() => D2cImportInputSchema.parse({ task: "", exportDir: "x" })).toThrow();
    expect(() => D2cImportInputSchema.parse({ task: "homepage", extra: 1 })).toThrow();
    expect(() => D2cGetReportInputSchema.parse({ task: "homepage", reportId: "" })).toThrow();
    expect(() => D2cGetReportInputSchema.parse({ task: "homepage", reportId: "../escape" })).toThrow();
    expect(() => D2cGetReportInputSchema.parse({ task: "homepage", reportId: "run-not-a-date" })).toThrow();
    expect(() => D2cReviewInputSchema.parse({ task: "homepage", reportId: "run-20260809-100000", fingerprints: [], decision: "accepted" })).toThrow();
    expect(() => D2cReviewInputSchema.parse({ task: "homepage", reportId: "run-20260809-100000", fingerprints: ["../escape"], decision: "accepted" })).toThrow();
    expect(() => D2cConfirmMappingInputSchema.parse({ task: "homepage", moduleId: "../x", operationKey: "GET /x" })).toThrow();
    expect(() => D2cManualAcceptanceInputSchema.parse({ task: "homepage", accepted: "yes" })).toThrow();
    expect(() => D2cManualAcceptanceInputSchema.parse({ task: "homepage", accepted: true, url: "https://evil.test" })).toThrow();
    expect(() => D2cJudgeConfigInputSchema.parse({ protocol: "openai-compatible", baseURL: "file:///tmp/model",
      apiKey: "secret", model: "vision-pro", passThreshold: 85 })).toThrow();
  });
});
