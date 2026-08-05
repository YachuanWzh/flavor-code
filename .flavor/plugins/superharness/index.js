// superharness flavor-code plugin
// Registers the superharness skill root so that go, brainstorm, tdd, etc.
// are discovered under the /superharness namespace, and registers three
// lifecycle hooks mirroring the Claude Code hooks:
//   SessionStart     inject HARNESS.md (+ STACK.md when present) as additionalContext
//   UserPromptSubmit auto-bootstrap ralph tracking on `/superharness:go <goal>`
//   Stop             append a 'round' heartbeat to trace.jsonl while a go task runs
// All hooks are best-effort and always return { decision: "allow" }.

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PLUGIN_ROOT = dirname(fileURLToPath(import.meta.url));
const ALLOW = Object.freeze({ decision: "allow" });

// The workspace path is cached from SessionStart (payload.workspace is a string);
// hooks fall back to the process working directory when it is unavailable.
let workspaceRoot;

function projectRoot(event) {
  const workspace = event?.payload?.workspace;
  if (typeof workspace === "string" && workspace.length > 0) return workspace;
  if (typeof workspaceRoot === "string" && workspaceRoot.length > 0) return workspaceRoot;
  return process.cwd();
}

function ralphDir(root) {
  return join(root, ".claude", "superharness", "ralph");
}

function isoNow() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "+00:00");
}

function atomicWrite(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, text, "utf8");
  renameSync(tmp, path);
}

function readJson(path) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return undefined; }
}

function readText(path) {
  try {
    const text = readFileSync(path, "utf8");
    return text.length > 0 ? text : undefined;
  } catch { return undefined; }
}

function currentTaskPath(root) {
  return join(ralphDir(root), ".current-task");
}

function getCurrentTask(root) {
  const raw = readText(currentTaskPath(root));
  const line = raw === undefined ? "" : raw.trim();
  return line.length > 0 ? line : undefined;
}

function appendTrace(root, phase, traceEvent, detail) {
  const line = JSON.stringify({ ts: isoNow(), phase, event: traceEvent, detail: detail ?? "" });
  const path = join(ralphDir(root), "trace.jsonl");
  mkdirSync(dirname(path), { recursive: true });
  const existing = readText(path) ?? "";
  writeFileSync(path, `${existing}${line}\n`, "utf8");
}

// Parse a go invocation at the start of the prompt. flavor-code invokes skills
// as `/go <goal>`; the Claude-style `superharness:go <goal>` is also accepted.
// Returns { goal, slug } or undefined.
function goInvocation(prompt) {
  if (typeof prompt !== "string") return undefined;
  const match = /^\s*(?:\/go|superharness:go)(?:[^A-Za-z0-9_]|$)/.exec(prompt);
  if (match === null) return undefined;
  const goal = prompt.replace(/^\s*(?:\/go|superharness:go)[ \t]*/, "").trim();
  const now = new Date();
  const date = now.toISOString().slice(0, 10);
  const tokens = (goal.toLowerCase().match(/[a-z0-9]+/g) ?? []).slice(0, 6);
  const kebab = tokens.length > 0
    ? tokens.join("-")
    : `task-${String(now.getUTCHours()).padStart(2, "0")}${String(now.getUTCMinutes()).padStart(2, "0")}${String(now.getUTCSeconds()).padStart(2, "0")}`;
  return { goal, slug: `${date}-${kebab}` };
}

// Bootstrap a fresh go task: point .current-task, seed an empty task.json
// (planning/plan), open the trace ledger with task:started, reset retry state.
function startTask(root, taskId, goal) {
  atomicWrite(currentTaskPath(root), taskId.trim());
  atomicWrite(join(ralphDir(root), "task.json"), JSON.stringify({
    status: "planning",
    phase: "plan",
    sprint: { current: 0, total: 0 },
    tasks: [],
    updated_at: isoNow(),
  }));
  appendTrace(root, "plan", "task:started", goal);
  atomicWrite(join(ralphDir(root), ".ralph-state.json"), JSON.stringify({
    retries: 0, max: 5, updated_at: isoNow(),
  }));
}

function onSessionStart(event) {
  const workspace = event?.payload?.workspace;
  if (typeof workspace === "string" && workspace.length > 0) workspaceRoot = workspace;
  const harness = readText(join(PLUGIN_ROOT, "HARNESS.md"));
  if (harness === undefined) return ALLOW;
  let context = `<EXTREMELY_IMPORTANT>\nYou have superharness. Follow it for all engineering work in this project.\n\n${harness}\n</EXTREMELY_IMPORTANT>`;
  const stack = readText(join(PLUGIN_ROOT, "STACK.md"));
  if (stack !== undefined) {
    context += `\n\n<EXTREMELY_IMPORTANT>\nThis project targets a specific tech stack. Follow this guidance.\n\n${stack}\n</EXTREMELY_IMPORTANT>`;
  }
  return { decision: "allow", additionalContext: context };
}

function onUserPromptSubmit(event) {
  const root = projectRoot(event);
  const prompt = typeof event?.payload?.prompt === "string" ? event.payload.prompt : "";

  // 1. Auto-trigger on a go invocation (start/repoint a task automatically).
  const invocation = goInvocation(prompt);
  if (invocation !== undefined && invocation.slug !== getCurrentTask(root)) {
    startTask(root, invocation.slug, invocation.goal);
  }

  // 2. Stash the pending round so the Stop hook can record a heartbeat.
  atomicWrite(join(ralphDir(root), ".pending-prompt.json"), JSON.stringify({ ts: isoNow(), query: prompt }));
  return ALLOW;
}

function onStop(event) {
  const root = projectRoot(event);
  const pendingPath = join(ralphDir(root), ".pending-prompt.json");
  const current = getCurrentTask(root);
  if (current === undefined) {
    // Not tracking a go task — drop any stray pending prompt and bail.
    try { rmSync(pendingPath, { force: true }); } catch { /* ignore */ }
    return ALLOW;
  }
  const pending = readJson(pendingPath);
  const query = typeof pending?.query === "string" ? pending.query : "";
  const tasks = readJson(join(ralphDir(root), "task.json"));
  const phase = typeof tasks?.phase === "string" && tasks.phase.length > 0 ? tasks.phase : "go";
  appendTrace(root, phase, "round", query);
  try { rmSync(pendingPath, { force: true }); } catch { /* ignore */ }
  return ALLOW;
}

export function activate(context) {
  context.registerSkillRoot("superharness", "./skills");

  const guard = (fn) => (event, signal) => {
    try { return fn(event, signal); } catch { return ALLOW; }
  };
  const options = { failurePolicy: "allow" };

  const disposers = [
    context.registerHook("SessionStart", guard(onSessionStart), options),
    context.registerHook("UserPromptSubmit", guard(onUserPromptSubmit), options),
    context.registerHook("Stop", guard(onStop), options),
  ];
  return () => { for (const dispose of disposers.reverse()) dispose(); };
}

// Exported for tests.
export const __test = { goInvocation, onSessionStart, onUserPromptSubmit, onStop, ralphDir };
