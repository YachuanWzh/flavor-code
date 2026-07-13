// flavor-code → CodeIslandWin bridge
import net from "node:net";

const PIPE_TIMEOUT_MS = 4000;

function pipePath() {
  const user = (process.env.USERNAME || process.env.USER || "default").trim() || "default";
  const sep = String.fromCharCode(92);
  return sep + sep + "." + sep + "pipe" + sep + "codeisland-" + user;
}

function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.readableEnded) { resolve(Buffer.alloc(0)); return; }
    const chunks = [];
    process.stdin.on("data", (d) => chunks.push(d));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks)));
    process.stdin.on("error", () => resolve(Buffer.concat(chunks)));
  });
}

function transform(event) {
  const payload = event.payload || {};
  const result = {
    hook_event_name: event.type,
    session_id: `flavor-${process.ppid || process.pid}`,
    _source: "flavor-code",
    _ppid: process.ppid || process.pid,
  };
  if (typeof payload.tool === "string") result.tool_name = payload.tool;
  if (typeof payload.agent === "string") result.agent_type = payload.agent;
  if (payload.input && typeof payload.input === "object" && !Array.isArray(payload.input)) {
    result.tool_input = payload.input;
    for (const [key, value] of Object.entries(payload.input)) {
      if (typeof value === "string" && !(key in result)) result[key] = value;
    }
  }
  if (typeof payload.reason === "string") result.message = payload.reason;
  if (typeof payload.message === "string" && !result.message) result.message = payload.message;
  if (typeof payload.id === "string") result.agent_id = payload.id;
  if (typeof payload.description === "string" && !result.message) result.message = payload.description;
  if (typeof payload.modelId === "string") result.model = payload.modelId;
  if (typeof payload.iteration === "number") result.message = `iteration ${payload.iteration}`;
  return result;
}

function toHookDecision(pipeResponse) {
  try {
    const parsed = JSON.parse(pipeResponse);
    const dec = parsed?.hookSpecificOutput?.decision;
    if (dec?.behavior === "allow") {
      if (Array.isArray(dec.updatedPermissions) && dec.updatedPermissions.length > 0) {
        return { decision: "allow", additionalContext: "codeisland:allow-all" };
      }
      return { decision: "allow" };
    }
  } catch { /* ignore */ }
  return { decision: "deny" };
}

async function main() {
  const input = await readStdin();
  if (!input.length) process.exit(0);
  let event;
  try { event = JSON.parse(input.toString("utf8")); } catch { process.exit(0); }
  if (!event || typeof event !== "object" || Array.isArray(event)) process.exit(0);

  const blocking = event.type === "PermissionRequest";
  const transformed = transform(event);
  const pipe = pipePath();

  return new Promise((resolve) => {
    const socket = net.connect(pipe);
    let response = "";
    let settled = false;
    const finish = (code) => {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch { /* ignore */ }
      if (blocking && response) {
        process.stdout.write(JSON.stringify(toHookDecision(response)), () => process.exit(code));
      } else {
        process.exit(code);
      }
    };
    if (!blocking) {
      const t = setTimeout(() => finish(0), PIPE_TIMEOUT_MS);
      if (t.unref) t.unref();
    }
    socket.on("connect", () => socket.write(JSON.stringify(transformed) + "\n"));
    socket.on("data", (d) => { response += d.toString("utf8"); });
    socket.on("close", () => finish(0));
    socket.on("error", () => finish(0));
  });
}

main();
