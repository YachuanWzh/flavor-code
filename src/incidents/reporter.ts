/**
 * IncidentReporter — bridges flavor-code tool failures to the langgraph-claw
 * RCA alert pipeline via the AlertManager webhook endpoint.
 *
 * Architecture:
 *   flavor-code tool failure
 *         │
 *         ▼
 *   PostToolUseFailure hook (ToolRuntime)
 *         │
 *         ▼
 *   IncidentReporter.collect() → POST /api/otel/alerts → langgraph-claw
 *         │
 *         ▼
 *   P0: auto-RCA via agent harness  →  code-rca skill
 *   P1: stored + SSE broadcast  →  manual analysis
 *
 * Env vars:
 *   FLAVOR_INCIDENT_WEBHOOK_URL  — langgraph-claw base URL (default: http://localhost:8000)
 *   FLAVOR_INCIDENT_ENABLED      — "true" to enable reporting (default: false)
 */

import { execFileNoThrow } from "../utils/execFileNoThrow.js";
import type { HookHandler } from "../hooks/types.js";

const DEFAULT_WEBHOOK_URL = "http://localhost:8000";

/**
 * Map a tool-failure error code to a P0–P3 alert level.
 *
 * P0 (critical)  → tool errors (broken code path) — triggers auto-RCA
 * P1 (warning)   → permission / hook denials — manual review
 * P2 (info)      → approval-gated failures — low-priority
 * P3 (none)      → everything else
 */
const LEVEL_MAP: Record<string, string> = {
  tool_error: "P0",
  permission_denied: "P1",
  hook_denied: "P1",
  approval_required: "P2",
  unknown_tool: "P1",
  invalid_input: "P2",
  user_denied: "P1",
};

const SEVERITY_MAP: Record<string, string> = {
  P0: "critical",
  P1: "warning",
  P2: "info",
  P3: "none",
};

function errorLevel(code: string): string {
  return LEVEL_MAP[code] ?? "P3";
}

interface GitContext {
  branch: string | null;
  commit: string | null;
  dirty: boolean;
}

async function collectGitContext(workspace: string, timeoutMs = 3000): Promise<GitContext> {
  const [branchResult, commitResult, statusResult] = await Promise.all([
    execFileNoThrow("git", ["-C", workspace, "rev-parse", "--abbrev-ref", "HEAD"], { timeout: timeoutMs, useCwd: false }),
    execFileNoThrow("git", ["-C", workspace, "rev-parse", "--short", "HEAD"], { timeout: timeoutMs, useCwd: false }),
    execFileNoThrow("git", ["-C", workspace, "status", "--porcelain"], { timeout: timeoutMs, useCwd: false }),
  ]);
  return {
    branch: branchResult.code === 0 ? branchResult.stdout.trim() : null,
    commit: commitResult.code === 0 ? commitResult.stdout.trim() : null,
    dirty: statusResult.code === 0 && statusResult.stdout.trim().length > 0,
  };
}

export interface IncidentReporterOptions {
  /** Base URL of the langgraph-claw server. */
  webhookUrl?: string;
  /** When false the reporter is a no-op. */
  enabled?: boolean;
  /** Absolute workspace path for git context and alert metadata. */
  workspace: string;
}

/**
 * Create a ``PostToolUseFailure`` hook handler that reports tool failures to
 * langgraph-claw as AlertManager-compatible webhook alerts.
 *
 * The handler always returns ``{ decision: "allow" }`` — it is a pure observer
 * and does not alter the tool execution pipeline.
 */
export function createIncidentReporter(options: IncidentReporterOptions): HookHandler {
  const webhookUrl = (options.webhookUrl ?? process.env.FLAVOR_INCIDENT_WEBHOOK_URL ?? DEFAULT_WEBHOOK_URL).replace(/\/+$/, "");
  const enabled = options.enabled ?? (process.env.FLAVOR_INCIDENT_ENABLED === "true");
  const workspace = options.workspace;

  if (!enabled) {
    return (_event, _signal) => Promise.resolve({ decision: "allow" });
  }

  const alertEndpoint = `${webhookUrl}/api/otel/alerts`;

  return async (event, signal) => {
    // PostToolUseFailure payload shape (see ToolRuntime.registerPayloadSchema)
    const payload = event.payload as {
      tool: string;
      input: unknown;
      agent: string;
      error: { code: string; message: string };
    };
    const { tool, input, agent, error } = payload;
    const level = errorLevel(error.code);
    const severity = SEVERITY_MAP[level] ?? "none";
    const gitCtx = await collectGitContext(workspace);

    const descriptionParts = [
      `Tool: ${tool}`,
      `Agent: ${agent}`,
      `Error: [${error.code}] ${error.message}`,
      gitCtx.branch ? `Branch: ${gitCtx.branch}` : "(no git branch)",
      gitCtx.commit ? `Commit: ${gitCtx.commit}` : "(no git commit)",
      gitCtx.dirty ? "Working tree is dirty" : "Working tree is clean",
      `Workspace: ${workspace}`,
    ];

    if (input !== undefined) {
      try {
        descriptionParts.push(`Input: ${JSON.stringify(input)}`);
      } catch {
        descriptionParts.push(`Input: ${String(input)}`);
      }
    }

    const alert = {
      receiver: "flavor-code",
      status: "firing",
      alerts: [
        {
          status: "firing",
          labels: {
            alertname: `FlavorToolFailure:${tool}`,
            severity,
            service_name: "flavor-code",
            error_code: error.code,
            tool,
          },
          annotations: {
            summary: `[flavor-code] ${tool} failed: ${error.message}`,
            description: descriptionParts.join("\n"),
          },
          startsAt: new Date().toISOString(),
          endsAt: "",
        },
      ],
      groupLabels: {},
      commonLabels: {
        alertname: `FlavorToolFailure:${tool}`,
        severity,
        service_name: "flavor-code",
      },
      commonAnnotations: {},
      externalURL: "",
      version: "4",
    };

    try {
      const response = await fetch(alertEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(alert),
        signal,
      });
      if (!response.ok) {
        // Log but never throw — this is a fire-and-forget observer.
        console.error(
          `[incidents] langgraph-claw responded ${response.status}: ${await response.text().catch(() => "(no body)")}`,
        );
      }
    } catch (err) {
      // Connection refused / timeout — not fatal.
      console.error(`[incidents] Failed to report to ${alertEndpoint}: ${err instanceof Error ? err.message : String(err)}`);
    }

    return { decision: "allow" };
  };
}
