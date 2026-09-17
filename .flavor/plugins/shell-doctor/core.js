// shell-doctor core: pure, sandbox-safe classifier + failure ledger.
// No Node builtins are imported anywhere in this plugin so it also runs in
// the Worker/vm realm (only relative modules + JSON-serializable I/O).

const WIN_BASH_MARKERS = [
  /2>\s*\/dev\/null/,
  /\$\(/,
  /\|\s*(?:grep|head|tail|sed|awk)\b/,
  /\b(?:grep|sed|awk|which|touch|chmod)\s+-?\w/,
  /\bcat\s+\S+\s*\|\s*/,
];

const POSIX_CMD_MARKERS = [
  /2>\s*nul\b/,
  /\bchcp\b/,
  /[A-Za-z]:\\/,
  /%\w+%/,
  /\btype\s+\S+\s*2>/,
];

export function inferPlatform(workspace, text) {
  const ws = typeof workspace === "string" ? workspace : "";
  if (/^[A-Za-z]:[\\/]/.test(ws)) return "win32";
  if (/^[\\/]/.test(ws)) return "posix";
  const body = typeof text === "string" ? text : "";
  if (/windows powershell|cmd\.exe|system cannot find/i.test(body)) return "win32";
  return undefined;
}

export function commandText(input) {
  if (!input || typeof input !== "object") return "";
  const command = typeof input.command === "string" ? input.command : "";
  const args = Array.isArray(input.args) ? input.args.filter((a) => typeof a === "string").join(" ") : "";
  return `${command} ${args}`.trim();
}

const PATH_TOOLS = new Set(["Read", "Grep", "Glob", "Edit", "Write", "ApplyPatch"]);

const COMMAND_NOT_FOUND_MARKERS = [
  /is not recognized as an internal or external command/i,
  /:\s*command not found/i,
  /is not recognized as a name of a cmdlet/i,
];

// The PowerShell wrapper can mask a failed command with exitCode 0: real
// errors only surface inside the CLIXML stderr stream (<S S="Error">).
// Those signatures must also count as failures, otherwise the doctor is
// blind on Windows hosts.
const MASKED_FAILURE_MARKERS = [
  /is not recognized as a name of a cmdlet/i,
  /<S S="Error">/,
];

export function classifyFailure({ tool, input, text, workspace } = {}) {
  const body = typeof text === "string" ? text : "";
  if (tool !== "Shell") {
    if (/outside (?:the )?workspace|workspace boundary/i.test(body) && hasPathInput(input)) {
      return {
        ruleId: "out-of-workspace",
        note: "The target path is outside the workspace, so the built-in Read/Grep refuse it by design. Use the read_external tool for out-of-workspace files instead of retrying.",
      };
    }
    if (PATH_TOOLS.has(tool) && /ENOENT|no such file|does not exist/i.test(body)
      && hasPathInput(input)) {
      return {
        ruleId: "bad-path-guess",
        note: "The referenced path likely does not exist. Locate files with Glob or ast_search before reading/editing; never reconstruct paths from memory.",
      };
    }
    return undefined;
  }
  const command = commandText(input);
  const platform = inferPlatform(workspace, body);
  if (platform === "win32" && WIN_BASH_MARKERS.some((re) => re.test(command) || re.test(body))) {
    return {
      ruleId: "win-bash-mismatch",
      note: "Host shell is cmd.exe/PowerShell: bash syntax (2>/dev/null, $(...), | grep, | head) will not run. Prefer the Glob/Grep/Read tools for the same intent, or read_external for out-of-workspace files.",
    };
  }
  if (platform === "posix" && POSIX_CMD_MARKERS.some((re) => re.test(command) || re.test(body))) {
    return {
      ruleId: "posix-cmd-mismatch",
      note: "Host shell is POSIX (bash/zsh): cmd.exe syntax (2>nul, chcp, C:\\ paths, %VAR%) will not run. Use 2>/dev/null, forward-slash paths, and $VAR instead.",
    };
  }
  if (COMMAND_NOT_FOUND_MARKERS.some((re) => re.test(body))) {
    const binary = typeof input?.command === "string" ? input.command : "the command";
    return {
      ruleId: "command-not-found",
      note: `\`${binary}\` is not installed or not on PATH. Verify installation, or use built-in tools (Grep/Glob/Read) which need no external binaries.`,
    };
  }
  return undefined;
}

function hasPathInput(input) {
  return !!input && typeof input === "object"
    && ["path", "file", "glob"].some((key) => typeof input[key] === "string" && input[key].length > 0);
}

export function createShellDoctor() {
  // pending: notes waiting to be flushed on the next UserPromptSubmit
  // (the only hook channel whose additionalContext the runtime consumes).
  // failedKeys: shell command line -> verdict, used to deny exact repeats.
  const pending = new Map();
  const failedKeys = new Map();

  function record(verdict, commandKey) {
    if (verdict === undefined) return;
    const entry = pending.get(verdict.ruleId) ?? { ruleId: verdict.ruleId, note: verdict.note, count: 0 };
    entry.count += 1;
    pending.set(verdict.ruleId, entry);
    if (commandKey !== undefined && commandKey.length > 0) failedKeys.set(commandKey, verdict);
  }

  function onPostToolUse(payload) {
    try {
      if (payload?.tool === "Shell" && payload.output !== null && typeof payload.output === "object") {
        const out = payload.output;
        const exitCode = typeof out.exitCode === "number" ? out.exitCode : undefined;
        const cancelled = out.terminationReason === "cancelled";
        const text = `${typeof out.stderr === "string" ? out.stderr : ""}\n${typeof out.stdout === "string" ? out.stdout : ""}`;
        const failed = !cancelled && exitCode !== undefined && (
          exitCode !== 0
          || (exitCode === 0 && MASKED_FAILURE_MARKERS.some((re) => re.test(text)))
        );
        if (failed) {
          record(classifyFailure({ tool: "Shell", input: payload.input, text, workspace: payload.workspace }),
            commandText(payload.input));
        }
      }
    } catch { /* best-effort observation only */ }
    return { decision: "allow" };
  }

  function onPostToolUseFailure(payload) {
    try {
      const error = payload?.error ?? {};
      record(classifyFailure({
        tool: typeof payload?.tool === "string" ? payload.tool : "",
        input: payload?.input,
        text: typeof error.message === "string" ? error.message : "",
        workspace: payload?.workspace,
      }), payload?.tool === "Shell" ? commandText(payload.input) : undefined);
    } catch { /* best-effort observation only */ }
    return { decision: "allow" };
  }

  function onUserPromptSubmit() {
    if (pending.size === 0) return { decision: "allow" };
    const body = [...pending.values()]
      .map((entry) => `- [${entry.ruleId}${entry.count > 1 ? ` x${entry.count}` : ""}] ${entry.note}`)
      .join("\n");
    pending.clear();
    return {
      decision: "allow",
      additionalContext: `shell-doctor observed tool failures since your last prompt. Apply these corrections instead of retrying the same mistake:\n${body}`,
    };
  }

  function onPreToolUse(payload) {
    try {
      if (payload?.tool === "Shell") {
        const verdict = failedKeys.get(commandText(payload.input));
        if (verdict !== undefined) {
          return {
            decision: "deny",
            reason: `shell-doctor: this exact command already failed (${verdict.ruleId}). ${verdict.note} Fix the approach or use a different command.`,
          };
        }
      }
    } catch { /* never block tools on doctor bugs */ }
    return { decision: "allow" };
  }

  return { onPostToolUse, onPostToolUseFailure, onUserPromptSubmit, onPreToolUse, failedKeys };
}
