import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditLogger } from "../../src/utils/log.js";

describe("AuditLogger end-to-end", () => {
  it("writes structured JSON-lines and supports read-back", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "flavor-audit-"));
    const logger = new AuditLogger(workspace);

    await logger.append({
      timestamp: new Date().toISOString(),
      sessionId: "test-verify-1",
      event: "PostToolUseFailure",
      tool: "Edit",
      agent: "main",
      errorCode: "tool_error",
      errorMessage: "oldText must match exactly once",
      input: { path: "foo.ts" },
    });

    await logger.append({
      timestamp: new Date().toISOString(),
      sessionId: "test-verify-1",
      event: "PostToolUseFailure",
      tool: "Grep",
      agent: "main",
      errorCode: "tool_error",
      errorMessage: "ripgrep exited with 2",
      input: { pattern: "[" },
    });

    await logger.append({
      timestamp: new Date().toISOString(),
      sessionId: "test-verify-2",
      event: "PostToolUseFailure",
      tool: "Edit",
      agent: "subagent",
      errorCode: "tool_error",
      errorMessage: "oldText must match exactly once",
      input: { path: "bar.ts" },
    });

    logger.close();
    // Wait for async writes to flush.
    await new Promise((resolve) => setTimeout(resolve, 300));

    // Read back using dynamic import to avoid .js resolution issues.
    const { readFile } = await import("node:fs/promises");
    const raw = await readFile(logger.path, "utf8");
    const lines = raw.trim().split("\n");

    expect(lines.length).toBe(3);

    const entries = lines.map((line) => JSON.parse(line));
    expect(entries[0].tool).toBe("Edit");
    expect(entries[0].sessionId).toBe("test-verify-1");
    expect(entries[2].tool).toBe("Edit");
    expect(entries[2].agent).toBe("subagent");

    // Verify Grep entry.
    const grepEntry = entries.find((e) => e.tool === "Grep");
    expect(grepEntry).toBeDefined();
    expect(grepEntry!.errorCode).toBe("tool_error");
    expect(grepEntry!.errorMessage).toContain("ripgrep");

    // Cleanup.
    await rm(workspace, { recursive: true, force: true });
  });
});
