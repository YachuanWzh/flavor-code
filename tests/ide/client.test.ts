import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { FlavorIdeClient } from "../../src/ide/client.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("FlavorIdeClient", () => {
  it("discovers a matching VS Code bridge and renders selected code context", async () => {
    const root = await mkdtemp(join(tmpdir(), "flavor-ide-"));
    roots.push(root);
    const workspace = join(root, "workspace");
    const ideDirectory = join(root, ".flavor-code", "ide");
    await Promise.all([mkdir(workspace), mkdir(ideDirectory, { recursive: true })]);
    await writeFile(join(ideDirectory, "43123.lock"), JSON.stringify({
      protocolVersion: 1,
      transport: "http",
      port: 43123,
      pid: 123,
      ideName: "Visual Studio Code",
      workspaceFolders: [workspace],
      authToken: "test-token",
    }));
    const request = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.endsWith("/health")) return new Response('{"ok":true}', { status: 200 });
      return new Response(JSON.stringify({
        ideName: "Visual Studio Code",
        workspaceFolders: [workspace],
        filePath: join(workspace, "src", "main.ts"),
        languageId: "typescript",
        dirty: false,
        selection: {
          start: { line: 4, character: 2 },
          end: { line: 5, character: 8 },
          active: { line: 5, character: 8 },
          isEmpty: false,
        },
        selectedText: "const flavor = true;",
      }), { status: 200 });
    });
    const client = new FlavorIdeClient({ workspace, home: root, environment: {}, fetch: request });

    await expect(client.status()).resolves.toContain("src/main.ts:6:9");
    await expect(client.editorContext()).resolves.toMatchObject({
      filePath: join(workspace, "src", "main.ts"),
      selectedText: "const flavor = true;",
    });
    await expect(client.promptContext()).resolves.toBe([
      '<ide_selection path="src/main.ts" start_line="5" end_line="6">',
      "const flavor = true;",
      "</ide_selection>",
    ].join("\n"));
    expect(request).toHaveBeenCalledWith("http://127.0.0.1:43123/context", expect.objectContaining({
      headers: { authorization: "Bearer test-token" },
    }));
  });

  it("ignores bridges for other workspaces", async () => {
    const root = await mkdtemp(join(tmpdir(), "flavor-ide-"));
    roots.push(root);
    const workspace = join(root, "workspace");
    const ideDirectory = join(root, ".flavor-code", "ide");
    await Promise.all([mkdir(workspace), mkdir(ideDirectory, { recursive: true })]);
    await writeFile(join(ideDirectory, "43124.lock"), JSON.stringify({
      transport: "http",
      port: 43124,
      ideName: "Visual Studio Code",
      workspaceFolders: [join(root, "other")],
      authToken: "test-token",
    }));
    const request = vi.fn<typeof fetch>();
    const client = new FlavorIdeClient({ workspace, home: root, environment: {}, fetch: request });

    await expect(client.promptContext()).resolves.toBeUndefined();
    await expect(client.status()).resolves.toMatch(/No matching/);
    expect(request).not.toHaveBeenCalled();
  });
});
