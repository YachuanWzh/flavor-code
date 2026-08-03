# Self-registering tools design

## Goal

Allow the main Flavor agent to create a durable callable tool while a task is running, use it on the next model iteration without restarting, list agent-created tools, and delete them. The capability must work in both the CLI and Electron desktop application through their shared production runtime.

## Reference: how pi implements the idea

Pi combines two distinct mechanisms:

1. Extension source is durable. TypeScript or JavaScript files under project `.pi/extensions/` or global `~/.pi/agent/extensions/` are rediscovered on startup and `/reload`.
2. Registration is live. An extension factory receives `pi.registerTool()`. During initial loading it fills the extension's tool map; after the runner is bound, the same call invokes `runtime.refreshTools()` so a newly registered definition becomes visible in the current session.

`/reload` is an explicit lifecycle operation, not a filesystem watcher. It refuses to run while streaming or compacting, emits shutdown, reloads settings/resources, clears the extension factory cache, creates a new extension runtime and runner, restores active tool names, and emits a new session start. Pi uses jiti with `moduleCache: false` for TypeScript and JavaScript loading. Auto-discovery is limited to direct extension files and one-level directories with `index.ts`, `index.js`, or a package manifest.

This separation is the important transferable idea: files provide persistence; replacement of the live tool registry provides immediate availability.

## Existing Flavor architecture

Flavor already has most of the required runtime path:

- `PluginHost` discovers project and global plugins and exposes a trusted in-process `registerTool` contribution API.
- `ToolRuntime.replaceTools()` replaces executable definitions.
- `LocalHarness.replaceMainTools()` replaces both executable definitions and the mutable model-facing tool schema array.
- `AgentLoop` copies that mutable schema array for every model request, so a replacement made by one tool call is visible on the next iteration of the same run.
- CLI and Electron both construct sessions through `createProductionRuntime()`.

Reloading the complete `PluginHost` for every generated tool would unnecessarily unload and reactivate unrelated hooks, commands, skill roots, and model adapters. Generated tools also need a package-independent schema representation: a plugin in `~/.flavor-code` cannot reliably resolve Flavor's bundled `zod` dependency in every global CLI and packaged Electron layout.

## Design

Add a dedicated `ManagedToolStore` beside the existing plugin host.

### Persistence

- Project tools: `<workspace>/.flavor/tools/<lowercase-name>.json`
- Global tools: `<home>/.flavor-code/tools/<lowercase-name>.json`
- Versioned record fields: `version`, `name`, `description`, JSON Schema `inputSchema`, JavaScript `implementation`, optional `agents`, and `createdAt`.
- Registration is create-only. An existing name is rejected case-insensitively. Modification is deliberately expressed as delete followed by add.
- New files use exclusive creation so an existing record cannot be overwritten by a race.
- Delete removes only the exact validated regular file associated with a managed record. It never recursively removes a directory and never deletes ordinary plugins or built-in tools.
- Project scope wins over global scope if externally created records collide. The collision is diagnosed and listing shows which entry is active.

### Runtime compilation

- JSON Schema is converted to a Zod validator with Zod 4 `fromJSONSchema` and is also retained verbatim as the provider-facing schema.
- `implementation` may be the body of an async JavaScript function, or a complete ordinary/async/arrow function expression. Every form receives `input`, `signal`, and frozen `context` (`workspace`, `scope`, and `toolName`) and returns its result.
- Syntax and schema conversion are validated before persistence.
- Like Flavor plugins, managed tool code is trusted in-process code, not a sandbox. Calls still pass through Flavor's normal hook and permission pipeline. Registering is a write operation; removal is destructive; generated tools are unknown-category calls and therefore require authorization unless policy explicitly permits them.

### Agent-facing management tools

- `RegisterTool`: accepts name, description, JSON Schema, an implementation body or complete function expression, scope (default `project`), and optional agent roles.
- `RemoveTool`: accepts name and optional scope. It can remove only managed tools.
- `ListRegisteredTools`: returns valid managed records, their scope/path, and whether each is active.

These are model-callable tools, not slash commands. Natural-language requests can cause the agent to call them, and the agent may propose one during a longer task when a genuinely reusable operation is beneficial. The normal permission prompt remains the user-visible confirmation boundary. System guidance prohibits creating a durable tool for a one-off action.

### Hot replacement

`createProductionRuntime()` loads managed records before plugins and MCP tools. After a successful add or delete it recomputes the managed definitions, updates the shared `tools` collection, and calls `LocalHarness.replaceMainTools()` when the harness is live. The current `AgentLoop` therefore receives the new schema on its next model request in the same run. Future subagents are built from the same shared definition collection; management tools themselves remain main-agent-only.

### Failure behavior

- Invalid record, JSON Schema, or JavaScript syntax: diagnose on startup and skip without crashing the session.
- Name conflict with a built-in, plugin, MCP, or another managed tool: reject registration; startup conflicts are diagnosed and the managed definition is not activated.
- Persistence failure: do not mutate the live registry.
- Live replacement failure after registration: remove the just-created record and restore the previous in-memory set.
- Deleting an ambiguous duplicate requires an explicit scope.

## Test strategy

1. Store unit tests cover create-only persistence, restart loading, execution, project/global precedence, invalid schema/source rejection, exact deletion, and symlink/invalid-file diagnostics.
2. Management-tool tests cover name conflicts, callback-driven hot replacement, rollback, and main-agent-only exposure.
3. Production integration drives a fake model through `RegisterTool` followed by a call to the newly created tool in the same agent run, then starts a second runtime to prove persistence. Because Electron and CLI share this runtime factory, this is the shared behavioral contract for both surfaces.
4. Prompt and permission tests cover usage guidance and write/destructive/read classification.
