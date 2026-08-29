// Self-contained fixture for the update-plugin invocation contract. The real
// plugin lives in an ignored per-user .flavor directory and must not be a test
// dependency in a clean checkout.

import { spawn as nodeSpawn } from "node:child_process";
import { existsSync as nodeExistsSync } from "node:fs";
import { join, delimiter } from "node:path";

const PACKAGE = "@flavor-code/plugin-manager";
const DEFAULT_UPDATE_ARGS = Object.freeze(["--all", "-y", "--force"]);
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;

function quoteCmdArg(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

export function resolveInvocation({
  platform = process.platform,
  execPath = process.execPath,
  fileExists = nodeExistsSync,
  comSpec = process.env.ComSpec,
  env = process.env,
  npxCliPath,
} = {}) {
  if (platform === "win32") {
    const candidates = [];
    if (npxCliPath) candidates.push(npxCliPath);
    candidates.push(join(execPath, "..", "node_modules", "npm", "bin", "npx-cli.js"));
    for (const dir of (env.PATH ?? env.Path ?? "").split(delimiter)) {
      if (dir) candidates.push(join(dir, "node_modules", "npm", "bin", "npx-cli.js"));
    }
    for (const candidate of candidates) {
      if (fileExists(candidate)) return { command: execPath, argsPrefix: [candidate] };
    }
    return { command: comSpec || "cmd.exe", argsPrefix: [], useCmdShell: true };
  }
  return { command: "npx", argsPrefix: [] };
}

function runPluginManager(args, { signal, timeoutMs, config }) {
  const { command, argsPrefix, useCmdShell } = resolveInvocation(config);
  const npxArgs = [...argsPrefix, "--yes", PACKAGE, ...args];
  const argv = useCmdShell
    ? ["/d", "/s", "/c", ["npx", ...npxArgs].map(quoteCmdArg).join(" ")]
    : npxArgs;
  const displayCommand = useCmdShell ? `${command} ${argv.join(" ")}` : [command, ...argv].join(" ");
  const spawn = config?.spawn ?? nodeSpawn;
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, argv, {
        shell: false,
        signal,
        windowsHide: true,
        timeout: timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS,
      });
    } catch (error) {
      resolve({ command: displayCommand, exitCode: null, error: String(error?.message ?? error), stdout: "", stderr: "" });
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      activeChildren.delete(child);
      resolve(result);
    };

    activeChildren.add(child);
    child.stdout.on("data", (chunk) => { if (stdout.length < MAX_OUTPUT_BYTES) stdout += chunk; });
    child.stderr.on("data", (chunk) => { if (stderr.length < MAX_OUTPUT_BYTES) stderr += chunk; });
    child.on("error", (error) => {
      finish({ command: displayCommand, exitCode: null, error: String(error?.message ?? error), stdout, stderr });
    });
    child.on("close", (code) => {
      finish({ command: displayCommand, exitCode: code, error: null, stdout, stderr });
    });
  });
}

const activeChildren = new Set();

function usage() {
  return {
    usage: [
      `/update-plugin                 # npx --yes ${PACKAGE} ${DEFAULT_UPDATE_ARGS.join(" ")}`,
      `/update-plugin <args...>       # pass args through to ${PACKAGE}`,
      "/update-plugin help            # show usage",
    ],
  };
}

export function activate(context) {
  const disposers = [];
  disposers.push(context.registerCommand("update-plugin", async (args) => {
    const words = Array.isArray(args) ? args.map(String) : [];
    if (words[0]?.toLowerCase() === "help") return usage();

    const managerArgs = words.length > 0 ? words : [...DEFAULT_UPDATE_ARGS];
    context.logger.info(`update-plugin: running npx --yes ${PACKAGE} ${managerArgs.join(" ")}`);
    const result = await runPluginManager(managerArgs, {
      signal: context.signal,
      timeoutMs: Number(context.config?.timeoutMs) || DEFAULT_TIMEOUT_MS,
      config: context.config,
    });
    return {
      ok: result.exitCode === 0,
      ...result,
      hint: result.exitCode === 0 ? undefined : "plugin-manager exited with a non-zero status",
    };
  }, "Update all plugins through @flavor-code/plugin-manager"));

  return async () => {
    for (const child of activeChildren) {
      try { child.kill("SIGTERM"); } catch { /* process may already be gone */ }
    }
    activeChildren.clear();
    for (const dispose of disposers.reverse()) {
      try { await dispose(); } catch { /* best effort during unload */ }
    }
  };
}
