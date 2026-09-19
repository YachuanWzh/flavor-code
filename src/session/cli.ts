import { join } from "node:path";
import type { Command } from "commander";

import type { SessionDocument, SessionEntry } from "./store.js";

/** The subset of {@link SessionStore} the CLI depends on, so tests can inject a fake. */
export interface SessionCliStore {
  list(): Promise<readonly SessionEntry[]>;
  load(sessionId?: string): Promise<SessionDocument>;
  delete(sessionId: string): Promise<void>;
}

export interface SessionCliDependencies {
  open?(options: { workspace: string }): SessionCliStore | Promise<SessionCliStore>;
  cwd?(): string;
  write?(text: string): void;
}

interface SessionSummary {
  sessionId: string;
  workspace: string;
  createdAt: string;
  updatedAt: string;
  mainModel: string;
  subagentModel: string;
  permissionMode: string;
  messageCount: number;
  turnCount: number;
  firstPrompt: string;
  lastReply: string;
}

export function registerSessionCommands(
  program: Command,
  dependencies: SessionCliDependencies = {},
): void {
  const cwd = dependencies.cwd ?? (() => process.cwd());
  const write = dependencies.write ?? ((text: string) => process.stdout.write(text));
  const open = dependencies.open ?? (async ({ workspace }: { workspace: string }) => {
    const { SessionStore } = await import("./store.js");
    return new SessionStore({ workspace });
  });
  const store = () => open({ workspace: cwd() });

  const sessions = program.command("sessions").description("List, inspect, export, and delete saved sessions");

  sessions.command("list", { isDefault: true })
    .description("List saved sessions, newest first")
    .option("--json", "print a machine-readable snapshot")
    .action(async (options: { json?: boolean }) => {
      const entries = await (await store()).list();
      if (options.json) {
        write(`${JSON.stringify(entries, null, 2)}\n`);
        return;
      }
      if (entries.length === 0) {
        write("No saved sessions in this workspace.\n");
        return;
      }
      for (const entry of entries) {
        write(`${entry.updatedAt}  ${entry.sessionId}  ${entry.mainModel}\n`);
      }
    });

  sessions.command("show [session-id]")
    .description("Show a summary of one session (the latest when id is omitted)")
    .option("--json", "print the summary as JSON")
    .action(async (sessionId: string | undefined, options: { json?: boolean }) => {
      const document = await (await store()).load(sessionId);
      const summary = summarize(document);
      if (options.json) {
        write(`${JSON.stringify(summary, null, 2)}\n`);
        return;
      }
      write(renderSummary(summary));
    });

  sessions.command("delete <session-id>")
    .description("Delete one saved session")
    .action(async (sessionId: string) => {
      await (await store()).delete(sessionId);
      write(`Deleted session ${sessionId}.\n`);
    });

  sessions.command("export <session-id>")
    .description("Export one session transcript to a file or stdout")
    .option("--format <format>", "export format: md or json", "md")
    .option("--output <path>", "write to a file instead of stdout")
    .action(async (sessionId: string, options: { format?: string; output?: string }) => {
      const format = options.format === "json" ? "json" : options.format === "md" ? "md" : undefined;
      if (format === undefined) {
        throw new Error(`Unsupported export format: ${options.format}. Use md or json.`);
      }
      const document = await (await store()).load(sessionId);
      const body = format === "json"
        ? `${JSON.stringify(document, null, 2)}\n`
        : renderTranscript(document);
      if (options.output === undefined) {
        write(body);
        return;
      }
      const { writeFile } = await import("node:fs/promises");
      const { resolve } = await import("node:path");
      await writeFile(resolve(options.output), body, "utf8");
      write(`Exported session ${sessionId} to ${resolve(options.output)}\n`);
    });

  sessions.command("path")
    .description("Print the sessions directory for the current workspace")
    .action(() => write(`${join(cwd(), ".flavor", "sessions")}\n`));
}

function summarize(document: SessionDocument): SessionSummary {
  const turns = [...document.timeline.state.completed];
  if (document.timeline.state.active !== undefined) turns.push(document.timeline.state.active);
  return {
    sessionId: document.sessionId,
    workspace: document.workspace.path,
    createdAt: document.createdAt,
    updatedAt: document.updatedAt,
    mainModel: document.models.main,
    subagentModel: document.models.subagent,
    permissionMode: document.permissionMode,
    messageCount: document.conversation.messages.length,
    turnCount: turns.length,
    firstPrompt: turns[0]?.prompt ?? "",
    lastReply: turns.length > 0 ? (turns[turns.length - 1]?.assistantText ?? "") : "",
  };
}

function renderSummary(summary: SessionSummary): string {
  const lines = [
    `Session ${summary.sessionId}`,
    `  workspace:  ${summary.workspace}`,
    `  created:    ${summary.createdAt}`,
    `  updated:    ${summary.updatedAt}`,
    `  models:     main=${summary.mainModel} subagent=${summary.subagentModel}`,
    `  permission: ${summary.permissionMode}`,
    `  messages:   ${summary.messageCount}   turns: ${summary.turnCount}`,
    `  first prompt: ${snippet(summary.firstPrompt)}`,
    `  last reply:   ${snippet(summary.lastReply)}`,
  ];
  return `${lines.join("\n")}\n`;
}

function renderTranscript(document: SessionDocument): string {
  const turns = [...document.timeline.state.completed];
  if (document.timeline.state.active !== undefined) turns.push(document.timeline.state.active);
  const header = [
    `# Session ${document.sessionId}`,
    "",
    `- workspace: ${document.workspace.path}`,
    `- created: ${document.createdAt}`,
    `- updated: ${document.updatedAt}`,
    `- models: main=${document.models.main} subagent=${document.models.subagent}`,
    `- permission: ${document.permissionMode}`,
    "",
  ].join("\n");
  const body = turns.map((turn) => {
    const prompt = turn.prompt.trim().length > 0 ? turn.prompt.trim() : "(no prompt)";
    const reply = turn.assistantText.trim();
    return `## ${prompt}\n\n${reply.length > 0 ? reply : "_(no assistant text)_"}\n`;
  }).join("\n");
  return `${header}${body.length > 0 ? body : "_No turns recorded._\n"}`;
}

function snippet(text: string, max = 120): string {
  const flat = text.replace(/\s+/gu, " ").trim();
  if (flat.length === 0) return "(empty)";
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}
