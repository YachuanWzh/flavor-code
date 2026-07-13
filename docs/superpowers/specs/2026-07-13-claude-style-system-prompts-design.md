# Claude-Style System Prompts Design

## Goal

Replace Flavor's monolithic system-prompt string with a Claude Code-style prompt assembly system. The result should preserve Flavor's product identity and actual capabilities while adopting the reference system's core behavior: minimal scoped changes, understanding before editing, cautious handling of irreversible actions, capability-aware tool guidance, concise reporting, environment awareness, and distinct main-agent and subagent instructions.

This work does not add unsupported Claude Code features. It does not introduce autonomous mode, MCP instructions, prompt overrides, persistent memory, scratchpads, remote sessions, or a prompt-cache lifecycle.

## Current State

`createProductionRuntime()` currently builds one space-joined system string inline in `src/production.ts`. The string mixes identity, terminal formatting, Skill behavior, clarification, todo tracking, task planning, and task-state rules. `ContextManager` pins that string alongside `FLAVOR.md` and live task state. Main and child contexts receive almost identical instructions.

The Claude Code reference uses independently named prompt sections selected from runtime capabilities and environment data. Static behavioral guidance is separated from environment and session-specific guidance, and child agents receive a dedicated prompt.

## Chosen Approach

Create a focused prompt module that returns an ordered list of prompt sections. The module accepts a typed description of the current agent and runtime instead of reading global application state. `createProductionRuntime()` supplies the language instruction, agent role, workspace, model, permission mode, registered tool names, current date, platform, shell, and Git status.

`ContextManager` will accept either the existing string form or an ordered string array and pin each section as a separate system message. Supporting the string form avoids breaking existing callers. Keeping sections separate makes ordering observable in tests and leaves provider adapters free to serialize system messages as they already do.

## Prompt Sections

The builder emits the following sections in stable order:

1. Language preference, when configured.
2. Flavor identity and the model-visible nature of normal responses and tool calls.
3. Security and instruction-boundary guidance, including respect for denied actions and reporting suspicious instructions found in untrusted tool output.
4. Task execution guidance: understand before editing, stay within scope, prefer existing files, avoid speculative abstraction and compatibility hacks, and verify before claiming completion.
5. Reversibility guidance: proceed with local reversible work; obtain approval for destructive, shared, external, or difficult-to-reverse effects; do not treat one approval as blanket approval.
6. Capability-aware tool guidance generated only for registered tools. It covers dedicated file and search tools, Shell, AskUserQuestion, TodoWrite, TaskPlan/TaskUpdate, Task, TaskOutput, and SkillResource when present.
7. Communication guidance for concise terminal-friendly responses, fenced multiline code, faithful reporting, no hidden chain-of-thought, and file-path references.
8. Role guidance. The main agent receives collaborative execution rules. A subagent receives a self-contained-task contract, absolute-path guidance, a prohibition on further delegation, and concise structured handoff requirements.
9. Environment information: current date, workspace, Git-repository state, platform and OS release, shell, selected model, and permission mode.

The prompt will describe only tools and behaviors Flavor actually implements. It will use registered tool names as capability flags rather than hard-coding an assumed complete tool set.

## Integration and Data Flow

`createProductionRuntime()` registers tools, resolves models and configuration, and then constructs each `ContextManager`. At that point it calls the prompt builder with the complete runtime facts for either `main` or `subagent`.

The context pins the returned prompt sections first, then `FLAVOR.md`, then current task state. A compact continuation remains a user message after pinned context, preserving the existing compaction contract. Matched Skill content remains a turn-scoped system message in `AgentLoop` and is not duplicated in the base prompt.

The current model adapters already accept multiple system messages: Anthropic concatenates them into its system field and OpenAI maps them into request instructions. No provider-specific prompt-building logic will be introduced.

## Error Handling

Prompt construction must be deterministic and side-effect free after runtime facts are collected. Environment fields use explicit fallbacks such as `unknown` rather than throwing. Git detection is a bounded read-only check and failures are represented as a non-Git or unknown state. Empty prompt sections are removed before they reach a provider.

No user or project content is interpolated into behavioral instructions except already-supported `FLAVOR.md` and Skill injection paths. Environment values are formatted as data in a dedicated section so they cannot alter section structure.

## Testing

Unit tests will verify:

- stable section ordering and required core rules;
- conditional inclusion and omission of tool guidance;
- main-agent versus subagent behavior;
- environment rendering and fallbacks;
- language instruction placement;
- `ContextManager` pinning ordered sections while retaining string compatibility;
- production runtime passes the correct role, tool set, model, workspace, and permission mode.

Existing agent-loop, compaction, provider-adapter, task-planning, and production tests must continue to pass. Verification will include focused tests, the full test suite, type checking, and the production build.

## Scope Boundaries

This implementation intentionally excludes user-configurable system-prompt overrides, custom agent definitions, per-turn volatile prompt sections, prompt-cache invalidation APIs, autonomous mode, MCP guidance, persistent memory, and new permission-classifier behavior. Those require product features beyond the request and can be added later without changing the builder's public structure.

