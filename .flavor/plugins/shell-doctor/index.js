// shell-doctor flavor-code disk plugin.
// Observes Shell/Path tool failures, injects corrective notes on the next
// user prompt (UserPromptSubmit.additionalContext), and denies exact retries
// of already-failed shell commands (PreToolUse deny.reason reaches the model
// as a hook_denied tool error). Pure ESM, relative imports only, no Node
// builtins: runs unmodified inside the Worker/vm plugin sandbox.

import { createShellDoctor } from "./core.js";

export function activate(context) {
  const doctor = createShellDoctor();
  const disposers = [
    context.registerHook("PreToolUse", (event) => doctor.onPreToolUse(event.payload)),
    context.registerHook("PostToolUse", (event) => doctor.onPostToolUse(event.payload)),
    context.registerHook("PostToolUseFailure", (event) => doctor.onPostToolUseFailure(event.payload)),
    context.registerHook("UserPromptSubmit", (event) => doctor.onUserPromptSubmit(event.payload)),
  ];
  context.logger.info("shell-doctor active");
  return () => {
    for (const dispose of disposers) dispose();
  };
}
