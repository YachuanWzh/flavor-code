// astgraph flavor-code plugin — codegraph-style code graph for precise navigation.
//
// Registers:
//   command  /ast            init | sync | status | search | impact | callers | callees | context | help
//   tools    ast_search / ast_callers / ast_callees / ast_impact / ast_context
//   hooks    SessionStart (cache workspace), PostToolUse (incremental sync after edits)
//
// Heavy lifting is lazy: activation only registers handlers so it stays well
// inside the host's activation timeout; WASM grammars and the database load on
// first use.

import { existsSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";

import { z } from "./vendor/zod/index.js";

const ALLOW = Object.freeze({ decision: "allow" });

function workspaceFrom(event) {
  const workspace = event?.payload?.workspace;
  if (typeof workspace === "string" && workspace.length > 0) return workspace;
  return undefined;
}

function dbPath(root) {
  return join(root, ".flavor", "astgraph", "index.db");
}

async function mod(name) {
  return import(new URL(`./${name}`, import.meta.url).href);
}

/** Open the graph database when it exists; otherwise undefined (not indexed yet). */
async function openIndex(root) {
  const path = dbPath(root);
  if (!existsSync(path)) return undefined;
  const { openDb } = await mod("db.mjs");
  return { db: openDb(path), path };
}

function workspaceRelative(root, path) {
  if (path === undefined) return undefined;
  const candidate = isAbsolute(path) ? relative(root, path) : path;
  return candidate.split("\\").join("/").replace(/^\.\//, "");
}

async function runIndex(root, options = {}) {
  const { openDb } = await mod("db.mjs");
  const { indexProject } = await mod("indexer.mjs");
  const db = openDb(dbPath(root));
  try {
    return await indexProject(root, { db, ...options });
  } finally {
    db.close();
  }
}

const HELP = {
  usage: [
    "/ast init                Build the full code graph (.flavor/astgraph/index.db)",
    "/ast sync [path...]      Incrementally re-index (defaults to changed files only)",
    "/ast status              Show graph statistics",
    "/ast search <query>      Find anchor symbols (FTS + identifier segments)",
    "/ast callers <node-id>   Who calls this node",
    "/ast callees <node-id>   What this node calls",
    "/ast impact <node-id> [--hops N] [--direction up|down|both]  Blast radius",
    "/ast context <node-id> [--hops N]  Precise file:line read ranges around a node",
  ],
  hint: "Node ids look like 'src/order.ts#cancelOrder'. Agent tools: ast_search, ast_callers, ast_callees, ast_impact, ast_context.",
};

async function commandAst(args, context) {
  const root = context.workspace;
  const [sub, ...rest] = args;
  switch (sub) {
    case undefined:
    case "help":
      return HELP;
    case "init": {
      const result = await runIndex(root);
      return { command: "init", workspace: root, db: dbPath(root), ...result };
    }
    case "sync": {
      const onlyPaths = rest.map((path) => workspaceRelative(root, path)).filter((path) => path !== undefined);
      const result = await runIndex(root, onlyPaths.length > 0 ? { onlyPaths } : {});
      return { command: "sync", ...result };
    }
    case "status": {
      const index = await openIndex(root);
      if (index === undefined) return { command: "status", indexed: false, hint: "Run /ast init first." };
      try {
        const { stats, getMetadata } = await mod("db.mjs");
        const lastIndex = getMetadata(index.db, "last_index");
        return { command: "status", indexed: true, db: index.path, ...stats(index.db), lastIndex: lastIndex === undefined ? undefined : JSON.parse(lastIndex) };
      } finally {
        index.db.close();
      }
    }
    default: {
      const nodeId = rest[0];
      if (["search", "callers", "callees", "impact", "context"].includes(sub) && (sub === "search" ? rest.length === 0 : nodeId === undefined)) {
        return { command: sub, error: `Missing ${sub === "search" ? "query" : "node id"}. See /ast help.` };
      }
      const index = await openIndex(root);
      if (index === undefined) return { command: sub, error: "Graph not built. Run /ast init first." };
      try {
        const { search, callers, callees, impact, subgraphContext, getNode } = await mod("query.mjs");
        if (sub === "search") return { command: sub, query: rest.join(" "), results: search(index.db, rest.join(" ")) };
        const anchor = getNode(index.db, nodeId);
        if (anchor === undefined) return { command: sub, error: `Unknown node id "${nodeId}". Use /ast search to find anchors.` };
        if (sub === "callers") return { command: sub, node: anchor, callers: callers(index.db, nodeId) };
        if (sub === "callees") return { command: sub, node: anchor, callees: callees(index.db, nodeId) };
        const hops = Math.min(5, Math.max(1, parseFlag(rest, "--hops", 2)));
        const direction = parseStringFlag(rest, "--direction", "up");
        if (sub === "impact") return { command: sub, ...impact(index.db, nodeId, { hops, direction: ["up", "down", "both"].includes(direction) ? direction : "up" }) };
        return { command: "context", ...subgraphContext(index.db, nodeId, { hops }) };
      } finally {
        index.db.close();
      }
    }
  }
}

function parseFlag(args, name, fallback) {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  const value = Number(args[index + 1]);
  return Number.isFinite(value) ? value : fallback;
}

function parseStringFlag(args, name, fallback) {
  const index = args.indexOf(name);
  return index < 0 ? fallback : args[index + 1] ?? fallback;
}

// Numeric fields use z.coerce so providers that serialize numbers as JSON
// strings ("10" instead of 10) still validate without a repair round-trip.
const boundedInt = (min, max) => z.coerce.number().int().min(min).max(max).optional();

function toolSchemas() {
  const nodeInput = z.object({
    id: z.string().describe("Node id, e.g. 'src/order.ts#cancelOrder' (find with ast_search)"),
  });
  return {
    ast_search: z.object({
      query: z.string().describe("Natural-language or symbol keywords, e.g. '订单 取消' or 'cancelOrder'"),
      limit: boundedInt(1, 50).describe("Max results (default 10)"),
    }),
    ast_callers: nodeInput,
    ast_callees: nodeInput,
    ast_impact: z.object({
      id: z.string().describe("Node id, e.g. 'src/order.ts#cancelOrder'"),
      hops: boundedInt(1, 5).describe("Traversal depth (default 2)"),
      direction: z.enum(["up", "down", "both"]).optional().describe("up=who depends on me, down=what I depend on (default up)"),
    }),
    ast_context: z.object({
      id: z.string().describe("Node id, e.g. 'src/order.ts#cancelOrder'"),
      hops: boundedInt(1, 3).describe("Subgraph depth (default 1)"),
    }),
  };
}

function createTools(rootRef) {
  const schemas = toolSchemas();
  const notIndexed = { ok: false, error: "astgraph index not built. Ask the user to run /ast init." };

  const withDb = async (fn) => {
    const root = rootRef();
    const index = await openIndex(root);
    if (index === undefined) return notIndexed;
    try {
      return await fn(index.db, root);
    } finally {
      index.db.close();
    }
  };

  return [
    {
      name: "ast_search",
      description: "Search the code graph for anchor symbols by keyword (full-text + identifier segments). Use before grep/read when locating where a change belongs.",
      inputSchema: schemas.ast_search,
      modelInputSchema: undefined,
      readOnly: true,
      paths: () => [],
      summarize: (input) => input.query,
      execute: async (input) => withDb(async (db) => {
        const { search } = await mod("query.mjs");
        return { results: search(db, input.query, { limit: input.limit ?? 10 }) };
      }),
    },
    {
      name: "ast_callers",
      description: "List the functions/classes that call or import a node in the code graph (upward dependencies).",
      inputSchema: schemas.ast_callers,
      readOnly: true,
      paths: () => [],
      summarize: (input) => input.id,
      execute: async (input) => withDb(async (db) => {
        const { callers, getNode } = await mod("query.mjs");
        const node = getNode(db, input.id);
        return node === undefined ? { error: `Unknown node id "${input.id}"` } : { node, callers: callers(db, input.id) };
      }),
    },
    {
      name: "ast_callees",
      description: "List the functions a node calls or imports (downward dependencies).",
      inputSchema: schemas.ast_callees,
      readOnly: true,
      paths: () => [],
      summarize: (input) => input.id,
      execute: async (input) => withDb(async (db) => {
        const { callees, getNode } = await mod("query.mjs");
        const node = getNode(db, input.id);
        return node === undefined ? { error: `Unknown node id "${input.id}"` } : { node, callees: callees(db, input.id) };
      }),
    },
    {
      name: "ast_impact",
      description: "Compute the K-hop blast radius of changing a node: who depends on it (up) or what it depends on (down). Use to scope a modification safely.",
      inputSchema: schemas.ast_impact,
      readOnly: true,
      paths: () => [],
      summarize: (input) => `${input.id} ${input.direction ?? "up"}x${input.hops ?? 2}`,
      execute: async (input) => withDb(async (db) => {
        const { impact, getNode } = await mod("query.mjs");
        if (getNode(db, input.id) === undefined) return { error: `Unknown node id "${input.id}"` };
        return impact(db, input.id, { hops: input.hops ?? 2, direction: input.direction ?? "up" });
      }),
    },
    {
      name: "ast_context",
      description: "Assemble the precise subgraph around a node: file paths and line ranges of the anchor, its callers and callees. Read only these ranges instead of grepping.",
      inputSchema: schemas.ast_context,
      readOnly: true,
      paths: () => [],
      summarize: (input) => input.id,
      execute: async (input) => withDb(async (db) => {
        const { subgraphContext } = await mod("query.mjs");
        return subgraphContext(db, input.id, { hops: input.hops ?? 1 });
      }),
    },
  ];
}

/** Extract workspace-relative file paths from a PostToolUse event's tool input. */
function changedPaths(event, root) {
  const payload = event?.payload;
  if (payload === undefined) return [];
  const input = payload.input ?? {};
  const tool = payload.tool;
  const paths = [];
  if (tool === "Edit" || tool === "Write") {
    if (typeof input.path === "string") paths.push(input.path);
  } else if (tool === "ApplyPatch" && typeof input.patch === "string") {
    for (const line of input.patch.split("\n")) {
      if (!line.startsWith("+++ ")) continue;
      const target = line.slice(4).trim().replace(/^b\//, "");
      if (target !== "/dev/null") paths.push(target);
    }
  }
  return paths
    .map((path) => workspaceRelative(root, path))
    .filter((path) => path !== undefined && /\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$/.test(path));
}

export function activate(context) {
  // Per-plugin-instance workspace cache, populated by SessionStart; falls back
  // to the host's command context workspace or the process cwd.
  let workspaceRoot;
  const rootRef = () => workspaceRoot ?? process.cwd();

  context.registerCommand("ast", commandAst, "Build and query the code AST graph");

  const disposers = [];
  for (const tool of createTools(rootRef)) disposers.push(context.registerTool(tool.name, tool));

  disposers.push(context.registerHook("SessionStart", (event) => {
    workspaceRoot = workspaceFrom(event) ?? workspaceRoot;
    return ALLOW;
  }, { failurePolicy: "allow" }));

  // Incremental sync after file-mutating tools. Fire-and-forget semantics:
  // never block or fail the agent's edit.
  let syncing = Promise.resolve();
  disposers.push(context.registerHook("PostToolUse", (event) => {
    const root = rootRef();
    const paths = changedPaths(event, root);
    if (paths.length === 0) return ALLOW;
    syncing = syncing
      .then(() => runIndex(root, { onlyPaths: paths }))
      .catch((error) => context.logger.debug(`astgraph sync skipped: ${error?.message ?? error}`));
    return ALLOW;
  }, { failurePolicy: "allow", timeoutMs: 10_000 }));

  return async () => {
    for (const dispose of disposers.reverse()) {
      try { await dispose(); } catch { /* ignore */ }
    }
  };
}
