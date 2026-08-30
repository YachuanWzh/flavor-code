import { describe, expect, it } from "vitest";

// @ts-expect-error - plain JS plugin core, no type declarations
import { createSecretGuard } from "../../.flavor/plugins/secret-guard/core.js";

const AWS_KEY = "AKIA" + "ABCDEFGHIJKLMNOP";
const GITHUB_TOKEN = "ghp_" + "a".repeat(36);
const JWT = ["eyJ" + "a".repeat(12), "b".repeat(12), "c".repeat(12)].join(".");

function guard() {
  return createSecretGuard();
}

describe("secret-guard", () => {
  it("allows ordinary edits", async () => {
    const g = guard();
    const result = await g.onPreToolUse({
      tool: "Write",
      input: { path: "src/util.ts", content: "export const add = (a: number, b: number) => a + b;" },
    });
    expect(result.decision).toBe("allow");
    expect(result.reason).toBeUndefined();
  });

  it("asks (not denies) when a write embeds an AWS key, without echoing the secret", async () => {
    const g = guard();
    const result = await g.onPreToolUse({
      tool: "Write",
      input: { path: "src/config.ts", content: `export const key = "${AWS_KEY}";` },
    });
    expect(result.decision).toBe("ask");
    expect(result.reason).toContain("aws-access-key-id");
    expect(result.reason).not.toContain(AWS_KEY);
  });

  it("asks when an edit adds a private key block", async () => {
    const g = guard();
    const result = await g.onPreToolUse({
      tool: "Edit",
      input: { path: "src/keys.ts", oldText: "x", newText: 'const k = "-----BEGIN RSA PRIVATE KEY-----"' },
    });
    expect(result.decision).toBe("ask");
    expect(result.reason).toContain("private-key");
  });

  it("asks when a patch assigns a long credential", async () => {
    const g = guard();
    const result = await g.onPreToolUse({
      tool: "ApplyPatch",
      input: { patch: "--- a/settings.py\n+++ b/settings.py\n+password = \"sup3rs3cr3tvalue123\"\n" },
    });
    expect(result.decision).toBe("ask");
    expect(result.reason).toContain("credential-assignment");
  });

  it("asks when a shell command carries a JWT or GitHub token", async () => {
    const g = guard();
    const jwt = await g.onPreToolUse({ tool: "Shell", input: { command: "curl", args: ["-H", `Authorization: ${JWT}`] } });
    expect(jwt.decision).toBe("ask");
    expect(jwt.reason).toContain("jwt");
    const gh = await g.onPreToolUse({ tool: "Shell", input: { command: `git clone https://${GITHUB_TOKEN}@github.com/x/y` } });
    expect(gh.decision).toBe("ask");
    expect(gh.reason).toContain("github-token");
  });

  it("asks when reading sensitive paths, allows normal ones", async () => {
    const g = guard();
    expect((await g.onPreToolUse({ tool: "Read", input: { path: "frontend/.env.local" } })).decision).toBe("ask");
    expect((await g.onPreToolUse({ tool: "Read", input: { path: ".ssh/id_rsa" } })).decision).toBe("ask");
    expect((await g.onPreToolUse({ tool: "Read", input: { path: "certs/server.pem" } })).decision).toBe("ask");
    const ok = await g.onPreToolUse({ tool: "Read", input: { path: "src/index.ts" } });
    expect(ok.decision).toBe("allow");
    expect(ok.reason).toBeUndefined();
  });

  it("asks when writing into an .env file even with benign-looking content", async () => {
    const g = guard();
    const result = await g.onPreToolUse({ tool: "Write", input: { path: ".env", content: "PORT=3000\n" } });
    expect(result.decision).toBe("ask");
    expect(result.reason).toContain("env-file");
  });

  it("ignores short placeholders that do not look like real secrets", async () => {
    const g = guard();
    const result = await g.onPreToolUse({
      tool: "Write",
      input: { path: "docs/sample.ts", content: 'const token = "abc"; // placeholder' },
    });
    expect(result.decision).toBe("allow");
  });
});
