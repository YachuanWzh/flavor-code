# MCP Client Integration Implementation Plan

> **For agentic workers:** Execute inline in the current workspace. Do not create a worktree, commit, stage, or dispatch subagents.

**Goal:** Connect configured MCP servers and expose their tools through Flavor Code's existing agent tool runtime.

**Architecture:** A focused MCP manager owns SDK clients, discovers tools, and adapts them into native tool definitions. Production composes those definitions with built-ins and closes the manager during every shutdown path.

**Tech Stack:** TypeScript, Zod 4, `@modelcontextprotocol/sdk` v1, Vitest.

## Global Constraints

- Work in the current checkout.
- Make no commits.
- Support stdio and Streamable HTTP only.
- A failed MCP server must not prevent other servers or Flavor Code from starting.
- Follow red-green-refactor for each behavior.

---

### Task 1: MCP configuration

**Files:** Modify `src/config/schema.ts`; test `tests/config/load.test.ts`.

**Interfaces:** Produce `McpServerConfigSchema`, `McpServerConfig`, and `FlavorConfig.mcpServers`.

- [ ] Add failing tests for defaults, valid stdio/HTTP entries, invalid mixed transports, and unsafe server names.
- [ ] Run `npx vitest run tests/config/load.test.ts` and verify the new assertions fail.
- [ ] Add the discriminated configuration schemas and defaults.
- [ ] Re-run the targeted test and verify it passes.

### Task 2: MCP manager and tool adapter

**Files:** Create `src/mcp/client.ts`, `src/mcp/sdk.ts`, and `tests/mcp/client.test.ts`.

**Interfaces:** Produce `connectMcpServers(options)`, `manager.tools`, `manager.diagnostics`, `manager.close()`, and an injectable client factory. Native tool execution forwards `{ name, arguments }` to MCP.

- [ ] Add failing unit tests for pagination, naming, execution, error conversion, abort forwarding, partial failure, and idempotent cleanup.
- [ ] Run `npx vitest run tests/mcp/client.test.ts` and verify failure because the implementation is absent.
- [ ] Install `@modelcontextprotocol/sdk@^1.29.0` and implement the minimal manager and SDK transport factory.
- [ ] Re-run the MCP tests and refactor only while green.

### Task 3: Permission classification

**Files:** Modify `src/permissions/engine.ts`; test `tests/permissions/engine.test.ts`.

**Interfaces:** `getToolCategory("mcp__server__tool")` returns `network`; permission decisions match other network tools.

- [ ] Add and run failing MCP permission assertions.
- [ ] Implement prefix classification in category lookup and decisions.
- [ ] Re-run permission tests.

### Task 4: Production lifecycle integration

**Files:** Modify `src/production.ts`; test `tests/cli/production.test.ts`.

**Interfaces:** Production connects configured servers before harness creation, supplies discovered definitions to agents/loop workers, reports diagnostics, and closes MCP exactly once.

- [ ] Add failing integration tests using an injected MCP factory seam.
- [ ] Wire the manager into startup, runtime tools, diagnostics, secrets, and cleanup paths.
- [ ] Re-run production tests and address only observed failures.

### Task 5: User documentation and verification

**Files:** Modify `README.md` and `.env.example` only if an environment example is needed.

- [ ] Document stdio and HTTP `mcpServers` examples, naming, permissions, diagnostics, and supported scope.
- [ ] Run MCP/config/permission/production test files.
- [ ] Run `npm test`, `npm run typecheck`, and `npm run build`.
- [ ] Inspect `git diff --check`, `git status --short`, and the complete diff; do not stage or commit.
