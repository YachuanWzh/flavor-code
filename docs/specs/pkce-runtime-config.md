# PKCE-managed runtime configuration specification

## Goal

For an OAuth-managed provider, the model shown by Flavor Code, the adapter
base URL, and the model sent in every SDK request must all come from the same
PKCE token response. Project files are never rewritten by login.

## Persistence

`~/.flavor-code/auth.json` remains the encrypted, user-global credential cache.
OAuth entries include `configVersion` and validated `llmConfig`. Credential
identity is derived from token URL plus client ID so separate PKCE services do
not collide. Legacy provider-name entries remain readable for migration.

## Effective runtime configuration

An OAuth token with `llm_config` produces one effective provider:

- runtime provider ID and display service name from PKCE;
- OpenAI or Anthropic adapter from `api_type`;
- adapter `baseURL` from the PKCE gateway URL;
- adapter API key from the OAuth access token;
- main, subagent, and selectable models from PKCE.

This overlay has priority over provider connection/model fields in project or
global `flavor.json`, but does not change MCP, skills, permissions, memory, or
other providers. No `flavor.json` file is written.

## UI and calls

`services.mainModel()` and all model consumers use the effective runtime model
ID (`provider_id:model`). The welcome card shows the PKCE service and effective
model. `ModelRegistry` removes the provider prefix and sends the same model name
to the SDK request. `/config` exposes a redacted effective view.

## Dynamic login

Explicit `/login` bypasses a valid cached token, completes PKCE, replaces the
adapter, switches main/subagent models, and updates UI state without restart.

## Session recovery

Conversation state may be restored. Stored model IDs are ignored when their
PKCE configuration version differs from the current cached version or when the
model is no longer allowed.

## Model consumers

Main agent, subagents, retries, permission classification, hallucination checks,
memory extraction, context compaction, sleep review, and goal planning must use
dynamic accessors rather than startup-captured model constants.

## Errors

`configuration_changed` instructs the user to run `/login`. Invalid token
metadata fails closed with a field-specific error. Token responses without
`llm_config` keep legacy OAuth behavior.

