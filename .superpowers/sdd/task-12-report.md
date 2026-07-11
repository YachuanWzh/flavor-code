# Task 12 Report: Interactive UI and Slash Commands

## Status

Implemented the interactive Flavor session, non-interactive print mode, and a production composition root. The CLI starts without provider credentials, keeps help/config commands available, and reports the exact setup path when a model cannot run.

## Architecture

- `src/ui/commands.ts` is a pure, closed MVP slash-command parser. It validates arguments and computes bounded edit-distance suggestions without invoking the harness.
- `src/ui/session.ts` owns command dispatch, balanced session hooks, cancellation, lifecycle state, and renderer-neutral output events.
- `src/ui/app.tsx` is the Ink renderer. It presents the compact `flavor · main model · workspace` status line, prompt history, streaming text, semantic usage/errors, approval input, and a single `┆`/`◆` execution rail.
- `src/production.ts` is the composition root. It loads layered configuration and `.env`, pins `FLAVOR.md`, registers model adapters and core tools, activates plugins, discovers skills, constructs contexts and the local harness, and exposes an approval bridge.
- `src/cli.tsx` dynamically imports Ink only for interactive mode. `--print <prompt>` uses the renderer-neutral session directly and returns exit code 1 for run/model errors or 2 for startup/usage failures.

The main loop accepts prompt-scoped additional context so a matching skill body is visible for that run but is not appended permanently. Model switching mutates only the selected role and preserves the main context. Permission switching mutates only the main permission engine; every newly created child continues to use workspace mode.

The main-only `Task` tool validates input through `TaskPlanner`, executes through `SubagentScheduler`, and returns only the scheduler's structured state/results object. Child execution uses `LocalHarness.runSubagent`, the configured subagent model, no `Task` tool, strict final JSON parsing, and the scheduler's one repair attempt.

Plugin tools, hooks, skill roots, and model adapters are connected through typed host callbacks. Duplicate core tools/providers are rejected. Plugin commands are recorded as diagnostics because the MVP command parser is intentionally closed. Unsupported provider types are also diagnostic rather than cast into an adapter.

## TDD Evidence

The focused RED/GREEN cycles covered:

- all MVP commands, invalid arguments, unknown suggestions, and absence of `/ide`;
- session hook balance, streaming, cancellation/exit, and secret redaction;
- startup without credentials and the approval bridge;
- mutable main/subagent models without context loss;
- prompt-scoped skill context without persistence;
- main-only mutable permission behavior and child restrictions;
- safe model-adapter deregistration for plugin unload.

Final verification evidence:

- `npm test -- tests/ui tests/cli` — 4 files passed, 24 tests passed.
- `npm test` — 20 files passed, 231 tests passed, 1 skipped.
- `npm run typecheck` — exit 0.
- `npm run build` — exit 0; the Ink app is emitted as a dynamic chunk.
- Built smoke test with provider keys removed: `node dist/cli.js --print "hello"` returned exit 1 and printed the actionable `.flavor/flavor.json` / environment-key guidance.
- Built smoke test: `node dist/cli.js --version` printed `0.1.0`.
- `git diff --check` — no whitespace errors.

## Security and Failure Behavior

- `/config` recursively redacts supported secret fields; bootstrap diagnostics additionally replace every configured/environment provider key value.
- Provider SDK construction failures become diagnostics. Missing adapters become an actionable model setup error on the first run rather than a startup crash.
- Non-interactive approval requests are denied instead of waiting for input.
- Plugin contribution conflicts are rejected and diagnosed; no unsafe contribution casts are used.
- The UI only consumes public agent events and has no chain-of-thought rendering path.

## Limitations

- Plugin-contributed slash commands are not executable in the MVP because command parsing is deliberately a closed union; `/plugins` and `/config` expose the resulting diagnostic.
- Context summarization in the production root is deterministic and local. It avoids a second credential-dependent bootstrap path but is less semantic than model-generated summarization.
- Ink interaction is covered through the renderer-neutral session tests rather than terminal snapshot tests; the built CLI paths were smoke-tested separately.
