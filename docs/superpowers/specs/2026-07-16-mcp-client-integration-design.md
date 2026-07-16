# MCP Client Integration Design

## Scope

Flavor Code will act as an MCP client for configured servers and expose their discovered tools to the main agent. The first version supports local stdio servers and remote Streamable HTTP servers. MCP resources, prompts, sampling, elicitation, and legacy HTTP+SSE are outside this change.

## Configuration

Add an `mcpServers` record to `flavor.json`. A server entry selects exactly one transport:

- stdio: `command`, optional `args`, `env`, and `cwd`
- Streamable HTTP: `url`, optional `headers`

Both variants accept `disabled` and `timeoutMs`. Existing environment interpolation applies to arguments, environment values, URLs, and headers. Server names are restricted to short function-name-safe identifiers.

## Runtime architecture

`McpManager` owns all MCP clients and transports for a Flavor runtime. It connects enabled servers independently, follows pagination while discovering tools, converts each JSON input schema to Zod, and creates native `ToolDefinition` adapters. Tool names use `mcp__<server>__<tool>` with deterministic sanitizing and hashing when a remote name is not provider-safe.

Calling an adapted tool forwards its original MCP name and validated arguments. Protocol failures and `isError` results become ordinary Flavor tool failures. Structured and unstructured MCP result fields remain available to the model. The caller abort signal is forwarded to the SDK request.

One unavailable or invalid server is skipped and recorded in runtime diagnostics; other configured servers remain usable. Duplicate generated tool names are rejected for the affected server.

## Permissions and lifecycle

Namespaced MCP tools are classified as network tools. Main-agent calls therefore require approval in `safe` and `workspace` modes and are allowed in `full` mode. Existing non-interactive policy continues to deny calls that need approval.

Production startup connects MCP before building the harness, appends discovered definitions to the common tool list, and includes them in loop workers. Runtime disposal closes every MCP client even when another cleanup step fails. Startup failure paths also close already-connected clients.

## Testing

Tests cover schema defaults and validation, stdio/HTTP factory options, a real stdio handshake and tool call, paginated discovery, name mapping, execution and cancellation, partial connection failure, error results, idempotent close, permission classification, production exposure, and cleanup. New tests and the build must pass; unrelated pre-existing full-suite or typecheck failures are reported explicitly.
