import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { initializeFlavor, inspectProject } from "../../src/init/project.js";

const temporaryDirectories: string[] = [];

async function createRepository(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "flavor-init-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
});

it("inspects an npm TypeScript project using only commands backed by scripts", async () => {
  const cwd = await createRepository();
  await mkdir(join(cwd, "src"));
  await mkdir(join(cwd, "tests"));
  await writeFile(
    join(cwd, "package.json"),
    JSON.stringify({
      name: "sample-app",
      scripts: {
        build: "tsc",
        test: "vitest run",
        lint: "eslint .",
        dev: "vite",
      },
    }),
  );
  await writeFile(join(cwd, "package-lock.json"), "{}");
  await writeFile(join(cwd, "tsconfig.json"), "{}");
  await writeFile(join(cwd, "AGENTS.md"), "User-owned instructions\n");
  await writeFile(join(cwd, ".gitignore"), "node_modules/\n");

  const facts = await inspectProject(cwd);

  expect(facts.languages).toEqual(["TypeScript"]);
  expect(facts.packageManager).toBe("npm");
  expect(facts.scripts).toEqual({
    build: "tsc",
    dev: "vite",
    lint: "eslint .",
    test: "vitest run",
  });
  expect(facts.buildCommands).toEqual(["npm run build"]);
  expect(facts.testCommands).toEqual(["npm test"]);
  expect(facts.lintCommands).toEqual(["npm run lint"]);
  expect(facts.formatCommands).toEqual([]);
  expect(facts.sourceDirectories).toEqual(["src", "tests"]);
  expect(facts.instructionFiles).toEqual(["AGENTS.md"]);
  expect(facts.gitignorePath).toBe(".gitignore");
});

it("uses a declared JavaScript package manager when no lockfile exists", async () => {
  const cwd = await createRepository();
  await writeFile(
    join(cwd, "package.json"),
    JSON.stringify({
      name: "pnpm-app",
      packageManager: "pnpm@10.13.1",
      scripts: { build: "tsc", test: "vitest run" },
    }),
  );

  const facts = await inspectProject(cwd);

  expect(facts.packageManager).toBe("pnpm");
  expect(facts.buildCommands).toEqual(["pnpm build"]);
  expect(facts.testCommands).toEqual(["pnpm test"]);
});

it("reports a package-manager conflict and consistently uses the declaration", async () => {
  const cwd = await createRepository();
  await writeFile(
    join(cwd, "package.json"),
    JSON.stringify({ packageManager: "yarn@4.9.2", scripts: { test: "vitest run" } }),
  );
  await writeFile(join(cwd, "package-lock.json"), "{}");

  const facts = await inspectProject(cwd);

  expect(facts.packageManager).toBe("yarn");
  expect(facts.packageManagers).toEqual(["yarn", "npm"]);
  expect(facts.testCommands).toEqual(["yarn test"]);
  expect(facts.cautions).toContain(
    "package.json declares yarn, but lockfiles for npm were also detected; using the declaration.",
  );
});

it("detects every JavaScript lockfile and omits commands when selection is ambiguous", async () => {
  const cwd = await createRepository();
  await writeFile(
    join(cwd, "package.json"),
    JSON.stringify({ scripts: { build: "tsc", test: "vitest run", lint: "eslint ." } }),
  );
  for (const lockfile of [
    "package-lock.json",
    "npm-shrinkwrap.json",
    "pnpm-lock.yaml",
    "yarn.lock",
    "bun.lock",
    "bun.lockb",
  ]) {
    await writeFile(join(cwd, lockfile), "");
  }

  const facts = await inspectProject(cwd);

  expect(facts.packageManager).toBeUndefined();
  expect(facts.packageManagers).toEqual(["npm", "pnpm", "yarn", "bun"]);
  expect(facts.buildCommands).toEqual([]);
  expect(facts.testCommands).toEqual([]);
  expect(facts.lintCommands).toEqual([]);
  expect(facts.cautions).toContain(
    "Multiple JavaScript lockfiles detected: package-lock.json, npm-shrinkwrap.json, pnpm-lock.yaml, yarn.lock, bun.lock, bun.lockb.",
  );
  expect(facts.cautions).toContain(
    "JavaScript package manager is ambiguous; script commands were omitted.",
  );
});

it("selects a declaration while retaining and reporting every conflicting lock", async () => {
  const cwd = await createRepository();
  await writeFile(
    join(cwd, "package.json"),
    JSON.stringify({ packageManager: "pnpm@10.0.0", scripts: { test: "vitest run" } }),
  );
  await writeFile(join(cwd, "package-lock.json"), "");
  await writeFile(join(cwd, "pnpm-lock.yaml"), "");
  await writeFile(join(cwd, "yarn.lock"), "");

  const facts = await inspectProject(cwd);

  expect(facts.packageManager).toBe("pnpm");
  expect(facts.packageManagers).toEqual(["pnpm", "npm", "yarn"]);
  expect(facts.testCommands).toEqual(["pnpm test"]);
  expect(facts.cautions).toContain(
    "package.json declares pnpm, but lockfiles for npm and yarn were also detected; using the declaration.",
  );
});

it("detects Python commands only when known configuration verifies them", async () => {
  const cwd = await createRepository();
  await mkdir(join(cwd, "src"));
  await mkdir(join(cwd, "tests"));
  await writeFile(
    join(cwd, "pyproject.toml"),
    [
      "[project]",
      'name = "sample-python"',
      "[tool.pytest.ini_options]",
      'testpaths = ["tests"]',
      "[tool.ruff]",
      'line-length = 100',
      "[tool.black]",
      'line-length = 100',
      "",
    ].join("\n"),
  );
  await writeFile(join(cwd, "uv.lock"), "version = 1\n");

  const facts = await inspectProject(cwd);

  expect(facts.languages).toEqual(["Python"]);
  expect(facts.packageManager).toBe("uv");
  expect(facts.testCommands).toEqual(["uv run pytest"]);
  expect(facts.lintCommands).toEqual(["uv run ruff check ."]);
  expect(facts.formatCommands).toEqual(["uv run black --check ."]);
  expect(facts.sourceDirectories).toEqual(["src", "tests"]);
});

it("recognizes test and quality tools declared in a bounded requirements manifest", async () => {
  const cwd = await createRepository();
  await writeFile(
    join(cwd, "requirements.txt"),
    "pytest==9.0.0\nruff>=0.12\nblack~=25.0\nrequests==2.0\n",
  );

  const facts = await inspectProject(cwd);

  expect(facts.packageManager).toBe("pip");
  expect(facts.testCommands).toEqual(["pytest"]);
  expect(facts.lintCommands).toEqual(["ruff check ."]);
  expect(facts.formatCommands).toEqual(["black --check ."]);
});

it("generates deterministic concise instructions without reading environment files", async () => {
  const cwd = await createRepository();
  await mkdir(join(cwd, "src"));
  await writeFile(
    join(cwd, "package.json"),
    JSON.stringify({ name: "safe-app", scripts: { test: "vitest run" } }),
  );
  await writeFile(join(cwd, "package-lock.json"), "{}");
  await writeFile(join(cwd, ".env"), "API_TOKEN=never-copy-this-secret\n");

  const first = await initializeFlavor(cwd);
  const firstContent = await readFile(join(cwd, "FLAVOR.md"), "utf8");
  const second = await initializeFlavor(cwd);
  const secondContent = await readFile(join(cwd, "FLAVOR.md"), "utf8");

  expect(first.created).toBe(true);
  expect(second.created).toBe(false);
  expect(first.path).toBe(join(cwd, "FLAVOR.md"));
  expect(firstContent).toBe(secondContent);
  expect(second.content).toBe(secondContent);
  expect(secondContent).toContain("<!-- flavor-code:start -->");
  expect(secondContent).toContain("## Overview");
  expect(secondContent).toContain("## Layout");
  expect(secondContent).toContain("## Build");
  expect(secondContent).toContain("## Test");
  expect(secondContent).toContain("## Quality");
  expect(secondContent).toContain("## Conventions");
  expect(secondContent).toContain("## Cautions");
  expect(secondContent).toContain("`npm test`");
  expect(secondContent).not.toContain("npm run build");
  expect(secondContent).not.toContain("never-copy-this-secret");
  expect(secondContent.length).toBeLessThan(2_500);
});

it("replaces only its marker-bounded CRLF section and preserves user content", async () => {
  const cwd = await createRepository();
  await writeFile(
    join(cwd, "package.json"),
    JSON.stringify({ name: "merge-app", scripts: { test: "node --test" } }),
  );
  const userPrefix = "# Team notes\r\n\r\nKeep this paragraph.\r\n\r\n";
  const userSuffix = "\r\n\r\n## Local rules\r\n\r\nPreserve this too.\r\n";
  await writeFile(
    join(cwd, "FLAVOR.md"),
    `${userPrefix}<!-- flavor-code:start -->\r\nstale\r\n<!-- flavor-code:end -->${userSuffix}`,
  );

  await initializeFlavor(cwd);
  const content = await readFile(join(cwd, "FLAVOR.md"), "utf8");

  expect(content.startsWith(userPrefix)).toBe(true);
  expect(content.endsWith(userSuffix)).toBe(true);
  expect(content).not.toContain("stale");
  expect(content.match(/<!-- flavor-code:start -->/g)).toHaveLength(1);
  expect(content).not.toContain("\r\r\n");
  expect(content.replace(/\r\n/g, "")).not.toContain("\n");
});

it("replaces the last valid marker pair while preserving a later unmatched start", async () => {
  const cwd = await createRepository();
  await writeFile(join(cwd, "package.json"), JSON.stringify({ name: "paired-app" }));
  const unmatched = "\n\nUser text\n<!-- flavor-code:start -->\nunmatched user marker\n";
  await writeFile(
    join(cwd, "FLAVOR.md"),
    `# Notes\n\n<!-- flavor-code:start -->\nstale generated text\n<!-- flavor-code:end -->${unmatched}`,
  );

  await initializeFlavor(cwd);
  const first = await readFile(join(cwd, "FLAVOR.md"), "utf8");
  await initializeFlavor(cwd);
  const second = await readFile(join(cwd, "FLAVOR.md"), "utf8");

  expect(first).toBe(second);
  expect(first).not.toContain("stale generated text");
  expect(first).toContain(unmatched);
  expect(first.match(/<!-- flavor-code:end -->/g)).toHaveLength(1);
});

it("adds the sessions directory to .gitignore exactly once without erasing content", async () => {
  const cwd = await createRepository();
  await writeFile(join(cwd, ".gitignore"), "dist/\r\n# local\r\n");

  await initializeFlavor(cwd);
  await initializeFlavor(cwd);
  const gitignore = await readFile(join(cwd, ".gitignore"), "utf8");

  expect(gitignore).toBe("dist/\r\n# local\r\n.flavor/sessions/\r\n");
});

it("handles malformed manifests safely and reports a caution", async () => {
  const cwd = await createRepository();
  await writeFile(join(cwd, "package.json"), "{ definitely-not-json");
  await writeFile(join(cwd, "package-lock.json"), "{}");

  const facts = await inspectProject(cwd);
  const result = await initializeFlavor(cwd);

  expect(facts.packageManager).toBe("npm");
  expect(facts.scripts).toEqual({});
  expect(facts.cautions).toContain("package.json could not be parsed; its scripts were ignored.");
  expect(result.content).toContain("package.json could not be parsed");
});

it("bounds and neutralizes malformed package names in generated Markdown", async () => {
  const cwd = await createRepository();
  await writeFile(
    join(cwd, "package.json"),
    JSON.stringify({
      name: `bad\n<!-- flavor-code:end -->\n${"x".repeat(5_000)}`,
      scripts: { test: "node --test" },
    }),
  );

  const result = await initializeFlavor(cwd);

  expect(result.content.match(/<!-- flavor-code:end -->/g)).toHaveLength(1);
  expect(result.content).not.toContain("bad\n");
  expect(result.content.length).toBeLessThan(2_500);
});

it("sanitizes and bounds the fallback directory name exactly like a manifest name", async () => {
  const root = await createRepository();
  const oversizedName = "x".repeat(180);
  const cwd = join(root, oversizedName);
  await mkdir(cwd);

  const facts = await inspectProject(cwd);

  expect(facts.projectName).toBe("x".repeat(120));
});

it("neutralizes fallback directory marker and control text where supported", async () => {
  const root = await createRepository();
  const unsafeName = "bad\n<!-- flavor-code:end -->";
  const cwd = join(root, unsafeName);
  try {
    await mkdir(cwd);
  } catch (error) {
    if (["EINVAL", "ENOENT"].includes((error as NodeJS.ErrnoException).code ?? "")) return;
    throw error;
  }

  const result = await initializeFlavor(cwd);

  expect(result.facts.projectName).toBe("bad flavor-code:end");
  expect(result.content.match(/<!-- flavor-code:end -->/g)).toHaveLength(1);
});

it("uses a safe literal when both manifest and fallback names sanitize empty", async () => {
  const root = await createRepository();
  const cwd = join(root, "\n\t");
  try {
    await mkdir(cwd);
  } catch (error) {
    if (["EINVAL", "ENOENT"].includes((error as NodeJS.ErrnoException).code ?? "")) return;
    throw error;
  }
  await writeFile(join(cwd, "package.json"), JSON.stringify({ name: "\u0001\u0002" }));

  const facts = await inspectProject(cwd);

  expect(facts.projectName).toBe("project");
});

it("ignores an oversized package manifest without copying its content", async () => {
  const cwd = await createRepository();
  const oversizedSecret = "do-not-copy-oversized-content";
  await writeFile(
    join(cwd, "package.json"),
    JSON.stringify({ name: oversizedSecret, padding: "x".repeat(1_000_000) }),
  );

  const result = await initializeFlavor(cwd);

  expect(result.facts.scripts).toEqual({});
  expect(result.facts.cautions).toContain(
    "package.json was too large to inspect; its scripts were ignored.",
  );
  expect(result.content).not.toContain(oversizedSecret);
});

it("does not follow repository symlinks or overwrite symlinked managed files", async () => {
  const root = await createRepository();
  const cwd = join(root, "repo");
  const outside = join(root, "outside");
  await mkdir(cwd);
  await mkdir(outside);
  const externalManifest = join(outside, "external-package.json");
  const externalFlavor = join(outside, "external-FLAVOR.md");
  await writeFile(
    externalManifest,
    JSON.stringify({ name: "external-secret-name", scripts: { test: "secret-command" } }),
  );
  await writeFile(externalFlavor, "outside must remain unchanged\n");
  try {
    await symlink(externalManifest, join(cwd, "package.json"), "file");
    await symlink(externalFlavor, join(cwd, "FLAVOR.md"), "file");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") return;
    throw error;
  }

  const facts = await inspectProject(cwd);

  expect(facts.projectName).toBe("repo");
  expect(facts.scripts).toEqual({});
  await expect(initializeFlavor(cwd)).rejects.toThrow(/symbolic link/i);
  await expect(readFile(externalFlavor, "utf8")).resolves.toBe(
    "outside must remain unchanged\n",
  );
});

it("refuses a symlinked gitignore without overwriting its external target", async () => {
  const root = await createRepository();
  const cwd = join(root, "repo");
  const externalGitignore = join(root, "external.gitignore");
  await mkdir(cwd);
  await writeFile(externalGitignore, "external remains unchanged\n");
  try {
    await symlink(externalGitignore, join(cwd, ".gitignore"), "file");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") return;
    throw error;
  }

  await expect(initializeFlavor(cwd)).rejects.toThrow(/symbolic link/i);
  await expect(readFile(externalGitignore, "utf8")).resolves.toBe(
    "external remains unchanged\n",
  );
});

it("does not scan dependency or generated directories when sampling languages", async () => {
  const cwd = await createRepository();
  await mkdir(join(cwd, "node_modules", "secret-package"), { recursive: true });
  await mkdir(join(cwd, "dist"), { recursive: true });
  await writeFile(join(cwd, "node_modules", "secret-package", "index.ts"), "");
  await writeFile(join(cwd, "dist", "main.py"), "");
  await writeFile(join(cwd, ".env"), "PRIVATE_LANGUAGE=Rust\n");

  const facts = await inspectProject(cwd);

  expect(facts.languages).toEqual([]);
  expect(facts.sourceDirectories).toEqual([]);
});
