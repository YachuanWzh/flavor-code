import { readFileSync, writeFileSync } from "node:fs";

const edits = {
  // ── anthropic.ts ── add parseJson import, remove local parseJson
  "src/models/anthropic.ts": {
    addImport: { after: `} from "./types.js";`, line: `import { parseJson } from "../utils/json.js";` },
    drop: [
      `function parseJson(input: string): unknown {\r\n  try {\r\n    return JSON.parse(input) as unknown;\r\n  } catch {\r\n    return input;\r\n  }\r\n}\r\n`,
    ],
  },

  // ── openai.ts ── add parseJson import, remove local parseJson
  "src/models/openai.ts": {
    addImport: { after: `} from "./types.js";`, line: `import { parseJson } from "../utils/json.js";` },
    drop: [
      `function parseJson(input: string): unknown {\r\n  try {\r\n    return JSON.parse(input) as unknown;\r\n  } catch {\r\n    return input;\r\n  }\r\n}\r\n`,
    ],
  },

  // ── agent/subagents.ts ── add imports, remove local functions
  "src/agent/subagents.ts": {
    addImport: { after: `} from "./planner.js";`, line: `import { awaitWithSignal } from "../utils/async.js";\nimport { message } from "../utils/error.js";` },
    replacements: [
      { from: "awaitWithSignal(", to: "awaitWithSignal(" }, // no change needed, name stays
      { from: "message(error)", to: "message(error)" },     // no change needed, name stays
    ],
    drop: [
      `function awaitWithSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {\r\n  signal.throwIfAborted();\r\n  return new Promise<T>((resolve, reject) => {\r\n    const onAbort = () => reject(signal.reason);\r\n    signal.addEventListener(\"abort\", onAbort, { once: true });\r\n    promise.then(\r\n      (value) => { signal.removeEventListener(\"abort\", onAbort); resolve(value); },\r\n      (error: unknown) => { signal.removeEventListener(\"abort\", onAbort); reject(error); },\r\n    );\r\n  });\r\n}\r\n`,
      `function message(error: unknown): string {\r\n  return error instanceof Error ? error.message : String(error);\r\n}\r\n`,
    ],
  },

  // ── context/manager.ts ── add import, remove local awaitWithSignal
  "src/context/manager.ts": {
    addImport: { after: `import type { ModelMessage } from "../models/types.js";`, line: `import { awaitWithSignal } from "../utils/async.js";` },
    drop: [
      `function awaitWithSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {\r\n  signal.throwIfAborted();\r\n  return new Promise<T>((resolve, reject) => {\r\n    const onAbort = () => reject(signal.reason);\r\n    signal.addEventListener(\"abort\", onAbort, { once: true });\r\n    promise.then(\r\n      (value) => { signal.removeEventListener(\"abort\", onAbort); resolve(value); },\r\n      (error: unknown) => { signal.removeEventListener(\"abort\", onAbort); reject(error); },\r\n    );\r\n  });\r\n}\r\n`,
    ],
  },

  // ── session/store.ts ── add import, remove local message
  "src/session/store.ts": {
    addImport: { after: `} from "../agent/subagents.js";`, line: `import { message } from "../utils/error.js";` },
    drop: [
      `function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }\r\n`,
    ],
  },

  // ── tools/runtime.ts ── add import, remove local message
  "src/tools/runtime.ts": {
    addImport: { after: `import type { ToolCall, ToolContext, ToolDefinition, ToolResult } from "./types.js";`, line: `import { message } from "../utils/error.js";` },
    drop: [
      `function message(error: unknown): string {\r\n  return error instanceof Error ? error.message : String(error);\r\n}\r\n`,
    ],
  },

  // ── hooks/bus.ts ── rename errorMessage → message, add import, remove local
  "src/hooks/bus.ts": {
    addImport: { after: `} from "./types.js";`, line: `import { message as errorMessage } from "../utils/error.js";` },
    replacements: [
      { from: "function errorMessage(error: unknown): string {\r\n  return error instanceof Error ? error.message : String(error);\r\n}\r\n", to: "" },
    ],
  },

  // ── plugins/host.ts ── add import, remove local message
  "src/plugins/host.ts": {
    addImport: { after: `} from "./types.js";`, line: `import { message } from "../utils/error.js";` },
    drop: [
      `function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }\r\n`,
    ],
  },

  // ── ui/app.tsx ── add imports, replace safeUiError with redactErrorText, remove local message/safeUiError
  "src/ui/app.tsx": {
    addImport: { after: `import { wrapPromptInput } from "./wrap-prompt.js";`, line: `import { message } from "../utils/error.js";\nimport { redactErrorText } from "../utils/redact.js";` },
    replacements: [
      {
        from: `function safeUiError(error: unknown): string {\r\n  return message(error)\r\n    .replace(/\\bsk-[A-Za-z0-9_-]+\\b/g, \"[redacted]\")\r\n    .replace(/(authorization|api[_ -]?key|token)\\s*[:=]\\s*\\S+/gi, \"$1=[redacted]\")\r\n    .slice(0, 2_000);\r\n}`,
        to: `function safeUiError(error: unknown): string {\r\n  return redactErrorText(message(error)).slice(0, 2_000);\r\n}`,
      },
    ],
    drop: [
      `function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }\r\n`,
    ],
  },

  // ── ui/session.ts ── add import, remove local message
  "src/ui/session.ts": {
    addImport: { after: `import { parseSlashCommand, type ModelRole, type SlashCommand } from "./commands.js";`, line: `import { message } from "../utils/error.js";` },
    drop: [
      `function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }\r\n`,
    ],
  },

  // ── cli.tsx ── replace safeError with shared imports
  "src/cli.tsx": {
    addImport: { after: `import { createProductionRuntime, type ProductionRuntime } from "./production.js";`, line: `import { message } from "./utils/error.js";\nimport { redactErrorText } from "./utils/redact.js";` },
    replacements: [
      {
        from: `function safeError(error: unknown): string {\r\n  return (error instanceof Error ? error.message : String(error))\r\n    .replace(/\\bsk-[A-Za-z0-9_-]+\\b/g, \"[redacted]\")\r\n    .replace(/(authorization|api[_ -]?key|token)\\s*[:=]\\s*\\S+/gi, \"$1=[redacted]\");\r\n}`,
        to: `function safeError(error: unknown): string {\r\n  return redactErrorText(message(error));\r\n}`,
      },
    ],
  },

  // ── production.ts ── heavy changes: imports, redactDiagnostic→redactSecrets, awaitWithAbort→awaitWithSignal, persist errors
  "src/production.ts": {
    addImport: { after: `import { MVP_COMMANDS } from "./ui/commands.js";`, line: `import { awaitWithSignal } from "./utils/async.js";\nimport { message } from "./utils/error.js";\nimport { redactSecrets } from "./utils/redact.js";` },
    replacements: [
      { from: "redactDiagnostic(", to: "redactSecrets(" },
      { from: "awaitWithAbort(", to: "awaitWithSignal(" },
      { from: "persistTail = persistTail.catch(() => undefined).then(() => sessionStore.save(sessionDocument()));", to: buildPersist() },
    ],
    drop: [
      `function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }\r\n`,
      `function redactDiagnostic(input: string, secrets: readonly string[]): string {\r\n  return secrets.reduce((text, secret) => text.replaceAll(secret, \"[redacted]\"), input);\r\n}\r\n`,
      `function awaitWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {\r\n  signal.throwIfAborted();\r\n  return new Promise<T>((resolvePromise, reject) => {\r\n    const onAbort = () => reject(signal.reason);\r\n    signal.addEventListener(\"abort\", onAbort, { once: true });\r\n    promise.then(\r\n      (value) => { signal.removeEventListener(\"abort\", onAbort); resolvePromise(value); },\r\n      (error: unknown) => { signal.removeEventListener(\"abort\", onAbort); reject(error); },\r\n    );\r\n  });\r\n}\r\n`,
    ],
  },
};

function buildPersist() {
  return `let persistFailed = false;
  const persist = (): Promise<void> => {
    persistTail = persistTail.catch(() => undefined).then(
      () => sessionStore.save(sessionDocument()),
    ).catch((err) => {
      if (!persistFailed) {
        persistFailed = true;
        try { options.output({ type: "notice", message: \`Session save failed: \${message(err)}. Your conversation may not be preserved.\` }); }
        catch { /* Output may be unavailable during shutdown */ }
      }
    });
    return persistTail;
  };`;
}

for (const [path, edit] of Object.entries(edits)) {
  let content = readFileSync(path, "utf8");

  // Add import
  if (edit.addImport) {
    const idx = content.indexOf(edit.addImport.after);
    if (idx === -1) {
      console.error(`WARNING: Could not find anchor "${edit.addImport.after.slice(0, 60)}..." in ${path}`);
    } else {
      const insertAt = idx + edit.addImport.after.length;
      content = content.slice(0, insertAt) + "\n" + edit.addImport.line + content.slice(insertAt);
    }
  }

  // Drop functions
  if (edit.drop) {
    for (const drop of edit.drop) {
      if (!content.includes(drop)) {
        console.error(`WARNING: Could not find drop text in ${path}: ${drop.slice(0, 60)}...`);
      }
      content = content.replace(drop, "");
    }
  }

  // Replacements
  if (edit.replacements) {
    for (const { from, to } of edit.replacements) {
      if (!content.includes(from)) {
        console.warn(`WARNING: Could not find replacement from in ${path}: ${from.slice(0, 60)}...`);
      }
      content = content.replace(from, to);
    }
  }

  // Clean up double blank lines
  content = content.replace(/\r\n\r\n\r\n/g, "\r\n\r\n");

  writeFileSync(path, content, "utf8");
  console.log(`OK  ${path}`);
}

console.log("\nDone. Run `npm run typecheck` to verify.");
