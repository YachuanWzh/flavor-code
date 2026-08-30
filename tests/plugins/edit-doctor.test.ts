import { describe, expect, it } from "vitest";

// @ts-expect-error - plain JS plugin core, no type declarations
import { createEditDoctor } from "../../.flavor/plugins/edit-doctor/core.js";

const BALANCED_TS = [
  "import { z } from \"zod\"; // note: ' won't confuse",
  "const re = /[\"'{]/;",
  "const div = 1 / 2 / 3;",
  "const tpl = `a ${ obj({ k: [1, 2] }) } b`;",
  "export function obj(v: unknown) { return { v }; }",
].join("\n");

function doctor(files: Record<string, string> = {}) {
  const readFile = async (path: string) => {
    const key = path.replace(/\\/g, "/").replace(/^.*?\/(?=src|docs|\+)/, "");
    if (key in files) return files[key];
    for (const [k, v] of Object.entries(files)) if (path.endsWith(k.replace(/^\.\//, ""))) return v;
    throw new Error("ENOENT " + path);
  };
  return createEditDoctor({ readFile });
}

async function start(d: ReturnType<typeof doctor>) {
  await d.onSessionStart({ workspace: "/w" });
}

describe("edit-doctor", () => {
  it("allows a well-formed Write", async () => {
    const d = doctor();
    await start(d);
    const r = await d.onPreToolUse({ tool: "Write", input: { path: "src/a.ts", content: BALANCED_TS } });
    expect(r.decision).toBe("allow");
  });

  it("asks (not denies) on a Write whose content has an unclosed brace", async () => {
    const d = doctor();
    await start(d);
    const r = await d.onPreToolUse({ tool: "Write", input: { path: "src/a.ts", content: "function f() { return 1;" } });
    expect(r.decision).toBe("ask");
    expect(r.reason).toContain("src/a.ts");
    expect(r.reason).toContain("unclosed");
  });

  it("asks on an unterminated string and on a mismatched close bracket", async () => {
    const d = doctor();
    await start(d);
    expect((await d.onPreToolUse({ tool: "Write", input: { path: "src/b.ts", content: "const s = \"abc\n" } })).decision).toBe("ask");
    expect((await d.onPreToolUse({ tool: "Write", input: { path: "src/c.ts", content: "const x = [1, 2);]" } })).decision).toBe("ask");
  });

  it("asks on invalid JSON but allows valid JSON", async () => {
    const d = doctor();
    await start(d);
    expect((await d.onPreToolUse({ tool: "Write", input: { path: "p/pkg.json", content: "{ \"a\": 1, }" } })).decision).toBe("ask");
    expect((await d.onPreToolUse({ tool: "Write", input: { path: "p/pkg.json", content: "{ \"a\": 1 }" } })).decision).toBe("allow");
  });

  it("skips non-code files", async () => {
    const d = doctor();
    await start(d);
    const r = await d.onPreToolUse({ tool: "Write", input: { path: "docs/readme.md", content: "broken {{{" } });
    expect(r.decision).toBe("allow");
  });

  it("marks a file broken after an Edit and asks on the next touch, then clears when fixed", async () => {
    const d = doctor({ "src/d.ts": "function f() { return 1;" });
    await start(d);
    const post = await d.onPostToolUse({ tool: "Edit", input: { path: "src/d.ts" }, output: { updated: true } });
    expect(post.decision).toBe("allow");
    const ask = await d.onPreToolUse({ tool: "Edit", input: { path: "src/d.ts", oldText: "1", newText: "2" } });
    expect(ask.decision).toBe("ask");
    expect(ask.reason).toContain("src/d.ts");
    // Fixed content written back through disk
    const fixed = doctor({});
    await start(fixed);
    await fixed.onPostToolUse({ tool: "Write", input: { path: "src/d.ts", content: "function f() { return 1; }" } });
    expect((await fixed.onPreToolUse({ tool: "Edit", input: { path: "src/d.ts", oldText: "1", newText: "2" } })).decision).toBe("allow");
  });

  it("injects staged notes once on the next user prompt", async () => {
    const d = doctor({ "src/e.ts": "const x = (1, 2;" });
    await start(d);
    await d.onPostToolUse({ tool: "Edit", input: { path: "src/e.ts" }, output: {} });
    const first = await d.onUserPromptSubmit({ prompt: "hi" });
    expect(first.additionalContext).toContain("src/e.ts");
    const second = await d.onUserPromptSubmit({ prompt: "hi again" });
    expect(second.additionalContext).toBeUndefined();
  });

  it("removes stale broken marks once a later write fixes the file", async () => {
    const broken = doctor({ "src/f.ts": "function g() {" });
    await start(broken);
    await broken.onPostToolUse({ tool: "Edit", input: { path: "src/f.ts" }, output: {} });
    expect((await broken.onPreToolUse({ tool: "Edit", input: { path: "src/f.ts", oldText: "a", newText: "b" } })).decision).toBe("ask");
    const fixed = doctor({ "src/f.ts": "function g() { return 1; }" });
    await start(fixed);
    await fixed.onPostToolUse({ tool: "Edit", input: { path: "src/f.ts" }, output: {} });
    expect((await fixed.onPreToolUse({ tool: "Edit", input: { path: "src/f.ts", oldText: "a", newText: "b" } })).decision).toBe("allow");
  });
});
