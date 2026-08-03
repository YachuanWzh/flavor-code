import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createManagedToolManagementTools,
  ManagedToolStore,
  type RegisterManagedToolInput,
} from "../../src/tools/managed.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<{ workspace: string; home: string; store: ManagedToolStore }> {
  const root = await mkdtemp(join(tmpdir(), "flavor-managed-tools-"));
  roots.push(root);
  const workspace = join(root, "workspace");
  const home = join(root, "home");
  const store = new ManagedToolStore({ workspace, home });
  await store.load();
  return { workspace, home, store };
}

function echoInput(overrides: Partial<RegisterManagedToolInput> = {}): RegisterManagedToolInput {
  return {
    name: "EchoUpper",
    description: "Uppercase the provided text",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
      additionalProperties: false,
    },
    implementation: "return { value: input.text.toUpperCase(), workspace: context.workspace };",
    scope: "project",
    agents: ["main", "subagent"],
    ...overrides,
  };
}

describe("ManagedToolStore", () => {
  it("persists, executes, reloads, and exactly deletes a project tool", async () => {
    const f = await fixture();
    const registered = await f.store.register(echoInput());

    expect(registered).toMatchObject({ name: "EchoUpper", scope: "project", active: true });
    expect(registered.path).toBe(join(f.workspace, ".flavor", "tools", "echoupper.json"));
    expect(JSON.parse(await readFile(registered.path, "utf8"))).toMatchObject({
      version: 1, name: "EchoUpper", description: "Uppercase the provided text",
    });
    const definition = f.store.definitions().find((tool) => tool.name === "EchoUpper");
    await expect(definition?.execute(
      { text: "flavor" }, new AbortController().signal,
    )).resolves.toEqual({ value: "FLAVOR", workspace: f.workspace });

    const restarted = new ManagedToolStore({ workspace: f.workspace, home: f.home });
    await restarted.load();
    expect(restarted.definitions().map((tool) => tool.name)).toContain("EchoUpper");
    expect(restarted.definitions()[0]?.modelInputSchema).toEqual(echoInput().inputSchema);

    const removed = await restarted.remove({ name: "EchoUpper" });
    expect(removed).toMatchObject({ name: "EchoUpper", scope: "project" });
    await expect(lstat(registered.path)).rejects.toMatchObject({ code: "ENOENT" });
    expect(restarted.definitions()).toEqual([]);
  });

  it.each([
    ["anonymous async function", "async function(input) { return input.text.toUpperCase(); }"],
    ["named function", "function execute(input) { return { value: input.text.toUpperCase() }; }"],
    ["async arrow function", "async (input) => input.text.toUpperCase()"],
  ])("executes a complete %s implementation", async (_format, implementation) => {
    const f = await fixture();
    await f.store.register(echoInput({ implementation }));

    const definition = f.store.definitions().find((tool) => tool.name === "EchoUpper");
    const result = await definition?.execute({ text: "flavor" }, new AbortController().signal);

    expect(result).toEqual(
      implementation.includes("{ value:") ? { value: "FLAVOR" } : "FLAVOR",
    );
  });

  it("is create-only and treats names case-insensitively", async () => {
    const f = await fixture();
    await f.store.register(echoInput());

    await expect(f.store.register(echoInput({ name: "echoupper" })))
      .rejects.toThrow(/already exists/i);
    expect(JSON.parse(await readFile(
      join(f.workspace, ".flavor", "tools", "echoupper.json"), "utf8",
    ))).toMatchObject({ name: "EchoUpper" });
  });

  it("validates JSON Schema and JavaScript syntax before creating a file", async () => {
    const f = await fixture();
    await expect(f.store.register(echoInput({
      name: "BadSchema",
      inputSchema: { type: "not-a-json-schema-type" },
    }))).rejects.toThrow(/schema/i);
    await expect(f.store.register(echoInput({
      name: "BadSource",
      implementation: "return ) broken (",
    }))).rejects.toThrow(/implementation/i);

    expect(f.store.list()).toEqual([]);
    await expect(lstat(join(f.workspace, ".flavor", "tools", "badschema.json")))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("uses project precedence for external duplicates and requires scoped deletion", async () => {
    const f = await fixture();
    const global = await f.store.register(echoInput({ scope: "global", implementation: "return 'global';" }));
    const projectPath = join(f.workspace, ".flavor", "tools", "echoupper.json");
    const projectRecord = JSON.parse(await readFile(global.path, "utf8"));
    projectRecord.scope = "project";
    projectRecord.implementation = "return 'project';";
    await mkdir(join(f.workspace, ".flavor", "tools"), { recursive: true });
    await writeFile(projectPath, JSON.stringify(projectRecord), "utf8");
    await f.store.load();

    expect(f.store.list()).toEqual([
      expect.objectContaining({ name: "EchoUpper", scope: "global", active: false }),
      expect.objectContaining({ name: "EchoUpper", scope: "project", active: true, path: projectPath }),
    ]);
    await expect(f.store.remove({ name: "EchoUpper" })).rejects.toThrow(/scope/i);
    const active = f.store.definitions()[0];
    await expect(active?.execute({}, new AbortController().signal)).resolves.toBe("project");

    await f.store.remove({ name: "EchoUpper", scope: "project" });
    await expect(f.store.definitions()[0]?.execute({}, new AbortController().signal)).resolves.toBe("global");
  });

  it("skips symlinks and malformed persisted records without loading executable code", async () => {
    const f = await fixture();
    const toolsRoot = join(f.workspace, ".flavor", "tools");
    await f.store.register(echoInput());
    await writeFile(join(toolsRoot, "invalid.json"), "{not json", "utf8");
    await mkdir(join(toolsRoot, "linked.json"));

    const restarted = new ManagedToolStore({ workspace: f.workspace, home: f.home });
    await restarted.load();

    expect(restarted.definitions().map((tool) => tool.name)).toEqual(["EchoUpper"]);
    expect(restarted.diagnostics.join("\n")).toMatch(/invalid\.json/i);
    expect(restarted.diagnostics.join("\n")).toMatch(/linked\.json.*regular file/i);
  });
});

describe("managed tool management definitions", () => {
  it("registers and removes tools through a hot-replacement callback", async () => {
    const f = await fixture();
    const changed = vi.fn();
    const tools = createManagedToolManagementTools({
      store: f.store,
      conflict: (name) => name === "Read" ? "built-in Read" : undefined,
      onChanged: changed,
    });
    const register = tools.find((tool) => tool.name === "RegisterTool")!;
    const removeTool = tools.find((tool) => tool.name === "RemoveTool")!;
    const list = tools.find((tool) => tool.name === "ListRegisteredTools")!;

    expect(register.agents).toEqual(["main"]);
    await expect(register.execute(echoInput(), new AbortController().signal))
      .resolves.toMatchObject({ name: "EchoUpper", availableImmediately: true });
    expect(changed).toHaveBeenCalledTimes(1);
    await expect(list.execute({}, new AbortController().signal))
      .resolves.toEqual([expect.objectContaining({ name: "EchoUpper", active: true })]);
    await expect(register.execute(echoInput({ name: "Read" }), new AbortController().signal))
      .rejects.toThrow(/built-in Read/);

    await expect(removeTool.execute({ name: "EchoUpper" }, new AbortController().signal))
      .resolves.toMatchObject({ name: "EchoUpper", removedImmediately: true });
    expect(changed).toHaveBeenCalledTimes(2);
  });

  it("rolls registration back when live replacement fails", async () => {
    const f = await fixture();
    const tools = createManagedToolManagementTools({
      store: f.store,
      conflict: () => undefined,
      onChanged: () => { throw new Error("replace failed"); },
    });
    const register = tools.find((tool) => tool.name === "RegisterTool")!;

    await expect(register.execute(echoInput(), new AbortController().signal))
      .rejects.toThrow("replace failed");
    expect(f.store.list()).toEqual([]);
  });
});
