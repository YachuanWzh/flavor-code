import { lstat, mkdir, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, relative, sep } from "node:path";

const GENERATED_START = "<!-- flavor-code:start -->";
const GENERATED_END = "<!-- flavor-code:end -->";
const MAX_MANIFEST_BYTES = 1_000_000;

const JAVASCRIPT_LOCKFILES = [
  { name: "package-lock.json", manager: "npm" },
  { name: "npm-shrinkwrap.json", manager: "npm" },
  { name: "pnpm-lock.yaml", manager: "pnpm" },
  { name: "yarn.lock", manager: "yarn" },
  { name: "bun.lock", manager: "bun" },
  { name: "bun.lockb", manager: "bun" },
] as const;

const SOURCE_DIRECTORIES = [
  "src",
  "app",
  "lib",
  "packages",
  "tests",
  "test",
  "spec",
] as const;

const INSTRUCTION_FILES = [
  "AGENTS.md",
  "CLAUDE.md",
  "GEMINI.md",
  ".github/copilot-instructions.md",
] as const;

const CONFIG_FILES = [
  "tsconfig.json",
  "jsconfig.json",
  "vitest.config.ts",
  "vitest.config.js",
  "jest.config.ts",
  "jest.config.js",
  "eslint.config.js",
  "eslint.config.mjs",
  ".eslintrc",
  ".eslintrc.json",
  "biome.json",
  "prettier.config.js",
  ".prettierrc",
  "pytest.ini",
  "tox.ini",
  ".ruff.toml",
  "ruff.toml",
  "mypy.ini",
] as const;

interface PackageManifest {
  name?: unknown;
  packageManager?: unknown;
  scripts?: unknown;
}

export interface ProjectFacts {
  cwd: string;
  projectName: string;
  languages: string[];
  packageManager?: string;
  packageManagers: string[];
  scripts: Record<string, string>;
  buildCommands: string[];
  testCommands: string[];
  lintCommands: string[];
  formatCommands: string[];
  sourceDirectories: string[];
  instructionFiles: string[];
  configFiles: string[];
  gitignorePath?: string;
  cautions: string[];
}

export interface InitResult {
  path: string;
  created: boolean;
  content: string;
  facts: ProjectFacts;
}

function isContainedPath(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return (
    pathFromRoot === "" ||
    (pathFromRoot !== ".." && !pathFromRoot.startsWith(`..${sep}`) && !isAbsolute(pathFromRoot))
  );
}

async function pathKind(
  path: string,
  root: string,
): Promise<"file" | "directory" | undefined> {
  try {
    const details = await lstat(path);
    if (details.isSymbolicLink() || !isContainedPath(root, await realpath(path))) return undefined;
    if (details.isFile()) return "file";
    if (details.isDirectory()) return "directory";
    return undefined;
  } catch (error) {
    if (isMissingPathError(error)) return undefined;
    throw error;
  }
}

function isMissingPathError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

async function readTextIfSmall(path: string, root: string): Promise<string | undefined> {
  const details = await lstat(path).catch((error: unknown) => {
    if (isMissingPathError(error)) return undefined;
    throw error;
  });
  if (
    details === undefined ||
    !details.isFile() ||
    details.isSymbolicLink() ||
    details.size > MAX_MANIFEST_BYTES ||
    !isContainedPath(root, await realpath(path))
  ) {
    return undefined;
  }
  return readFile(path, "utf8");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sanitizeProjectName(value: string): string | undefined {
  const sanitized = value
    .replace(/<!--/g, "")
    .replace(/-->/g, "")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
  return sanitized === "" ? undefined : sanitized;
}

function joinWithAnd(values: string[]): string {
  if (values.length < 2) return values[0] ?? "";
  return `${values.slice(0, -1).join(", ")} and ${values.at(-1)}`;
}

function packageCommand(manager: string, script: string): string {
  if (manager === "npm") {
    return script === "test" ? "npm test" : `npm run ${script}`;
  }
  if (manager === "yarn") return `yarn ${script}`;
  if (manager === "bun") return `bun run ${script}`;
  return `${manager} ${script}`;
}

function addScriptCommand(
  target: string[],
  scripts: Record<string, string>,
  manager: string | undefined,
  names: readonly string[],
): void {
  if (manager === undefined) return;
  const script = names.find((name) => scripts[name] !== undefined);
  if (script !== undefined) target.push(packageCommand(manager, script));
}

function detectPythonTools(
  pyproject: string | undefined,
  requirements: string | undefined,
  configFiles: string[],
): Set<string> {
  const tools = new Set<string>();
  const sections = pyproject?.matchAll(/^\s*\[tool\.([A-Za-z0-9_-]+)(?:\.|\])/gm) ?? [];
  for (const match of sections) {
    const tool = match[1];
    if (tool !== undefined) tools.add(tool.toLowerCase());
  }
  if (configFiles.includes("pytest.ini")) tools.add("pytest");
  if (configFiles.includes("ruff.toml") || configFiles.includes(".ruff.toml")) tools.add("ruff");
  for (const line of requirements?.split(/\r?\n/) ?? []) {
    const match = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(line);
    if (match?.[1] !== undefined && !line.trimStart().startsWith("#")) {
      tools.add(match[1].toLowerCase().replace(/[-_.]+/g, "-"));
    }
  }
  return tools;
}

async function sampleSourceExtensions(
  cwd: string,
  root: string,
  directories: string[],
): Promise<Set<string>> {
  const extensions = new Set<string>();
  const sampleDirectories = ["", ...directories].slice(0, 12);
  for (const relativeDirectory of sampleDirectories) {
    const absoluteDirectory = join(cwd, relativeDirectory);
    if (!isContainedPath(root, await realpath(absoluteDirectory))) continue;
    let entries;
    try {
      entries = await readdir(absoluteDirectory, { withFileTypes: true });
    } catch (error) {
      if (isMissingPathError(error)) continue;
      throw error;
    }
    for (const entry of entries.slice(0, 200)) {
      if (!entry.isFile()) continue;
      const match = /\.([A-Za-z0-9]+)$/.exec(entry.name);
      if (match?.[1] !== undefined) extensions.add(match[1].toLowerCase());
    }
  }
  return extensions;
}

export async function inspectProject(cwd: string): Promise<ProjectFacts> {
  const root = await realpath(cwd);
  const sourceDirectories: string[] = [];
  for (const directory of SOURCE_DIRECTORIES) {
    if ((await pathKind(join(cwd, directory), root)) === "directory") sourceDirectories.push(directory);
  }

  const instructionFiles: string[] = [];
  for (const file of INSTRUCTION_FILES) {
    if ((await pathKind(join(cwd, file), root)) === "file") instructionFiles.push(file);
  }

  const configFiles: string[] = [];
  for (const file of CONFIG_FILES) {
    if ((await pathKind(join(cwd, file), root)) === "file") configFiles.push(file);
  }

  const manifestNames = [
    "package.json",
    ...JAVASCRIPT_LOCKFILES.map(({ name }) => name),
    "pyproject.toml",
    "requirements.txt",
    "uv.lock",
    "poetry.lock",
    "Pipfile",
  ] as const;
  const present = new Set<string>();
  for (const manifest of manifestNames) {
    if ((await pathKind(join(cwd, manifest), root)) === "file") present.add(manifest);
  }

  const detectedLockfiles = JAVASCRIPT_LOCKFILES.filter(({ name }) => present.has(name));
  const detectedJsManagers = [
    ...new Set(detectedLockfiles.map(({ manager }) => manager)),
  ];
  const pythonManagers: string[] = [];
  if (present.has("uv.lock")) {
    pythonManagers.push("uv");
  } else if (present.has("poetry.lock")) {
    pythonManagers.push("poetry");
  } else if (present.has("Pipfile")) {
    pythonManagers.push("pipenv");
  } else if (present.has("pyproject.toml") || present.has("requirements.txt")) {
    pythonManagers.push("pip");
  }

  const cautions: string[] = [];
  if (detectedLockfiles.length > 1) {
    cautions.push(
      `Multiple JavaScript lockfiles detected: ${detectedLockfiles.map(({ name }) => name).join(", ")}.`,
    );
  }
  const scripts: Record<string, string> = {};
  let projectName = sanitizeProjectName(basename(cwd)) ?? "project";
  let declaredJsManager: string | undefined;
  if (present.has("package.json")) {
    const text = await readTextIfSmall(join(cwd, "package.json"), root);
    if (text === undefined) {
      cautions.push("package.json was too large to inspect; its scripts were ignored.");
    } else {
      try {
        const parsed: unknown = JSON.parse(text);
        if (!isRecord(parsed)) throw new Error("not an object");
        const manifest = parsed as PackageManifest;
        if (typeof manifest.name === "string") {
          projectName = sanitizeProjectName(manifest.name) ?? projectName;
        }
        if (typeof manifest.packageManager === "string") {
          declaredJsManager = /^(npm|pnpm|yarn|bun)@/.exec(manifest.packageManager)?.[1];
        }
        if (isRecord(manifest.scripts)) {
          for (const [name, command] of Object.entries(manifest.scripts).sort(([a], [b]) =>
            a < b ? -1 : a > b ? 1 : 0,
          )) {
            if (typeof command === "string") scripts[name] = command;
          }
        }
      } catch {
        cautions.push("package.json could not be parsed; its scripts were ignored.");
      }
    }
  }

  let selectedJsManager: string | undefined;
  if (declaredJsManager !== undefined) {
    selectedJsManager = declaredJsManager;
    const conflicts = detectedJsManagers.filter((manager) => manager !== declaredJsManager);
    if (conflicts.length > 0) {
      cautions.push(
        `package.json declares ${declaredJsManager}, but lockfiles for ${joinWithAnd(conflicts)} were also detected; using the declaration.`,
      );
    }
  } else if (detectedJsManagers.length === 1) {
    selectedJsManager = detectedJsManagers[0];
  } else if (detectedJsManagers.length === 0 && present.has("package.json")) {
    selectedJsManager = "npm";
  } else if (detectedJsManagers.length > 1) {
    cautions.push("JavaScript package manager is ambiguous; script commands were omitted.");
  }

  const orderedJsManagers = selectedJsManager === undefined
    ? detectedJsManagers
    : [selectedJsManager, ...detectedJsManagers.filter((manager) => manager !== selectedJsManager)];
  const packageManagers = [...orderedJsManagers, ...pythonManagers];
  const packageManager = selectedJsManager ?? pythonManagers[0];
  const jsManager = selectedJsManager;
  const buildCommands: string[] = [];
  const testCommands: string[] = [];
  const lintCommands: string[] = [];
  const formatCommands: string[] = [];
  addScriptCommand(buildCommands, scripts, jsManager, ["build"]);
  addScriptCommand(testCommands, scripts, jsManager, ["test"]);
  addScriptCommand(lintCommands, scripts, jsManager, ["lint"]);
  addScriptCommand(formatCommands, scripts, jsManager, ["format", "format:check"]);

  const pyproject = present.has("pyproject.toml")
    ? await readTextIfSmall(join(cwd, "pyproject.toml"), root)
    : undefined;
  const requirements = present.has("requirements.txt")
    ? await readTextIfSmall(join(cwd, "requirements.txt"), root)
    : undefined;
  const pythonTools = detectPythonTools(pyproject, requirements, configFiles);
  const pythonManager = pythonManagers[0];
  const pythonPrefix =
    pythonManager === "uv"
      ? "uv run "
      : pythonManager === "poetry"
        ? "poetry run "
        : pythonManager === "pipenv"
          ? "pipenv run "
          : "";
  if (pythonTools.has("pytest")) testCommands.push(`${pythonPrefix}pytest`);
  if (pythonTools.has("ruff")) lintCommands.push(`${pythonPrefix}ruff check .`);
  if (pythonTools.has("black")) formatCommands.push(`${pythonPrefix}black --check .`);

  const extensions = await sampleSourceExtensions(cwd, root, sourceDirectories);
  const languages = new Set<string>();
  const hasTypeScript = configFiles.includes("tsconfig.json") ||
    ["ts", "tsx", "mts", "cts"].some((extension) => extensions.has(extension));
  if (hasTypeScript) {
    languages.add("TypeScript");
  } else if (present.has("package.json") || ["js", "jsx", "mjs", "cjs"].some((extension) => extensions.has(extension))) {
    languages.add("JavaScript");
  }
  if (present.has("pyproject.toml") || present.has("requirements.txt") || extensions.has("py")) {
    languages.add("Python");
  }

  const gitignorePath =
    (await pathKind(join(cwd, ".gitignore"), root)) === "file" ? ".gitignore" : undefined;
  return {
    cwd,
    projectName,
    languages: [...languages].sort(),
    ...(packageManager === undefined ? {} : { packageManager }),
    packageManagers,
    scripts,
    buildCommands,
    testCommands,
    lintCommands,
    formatCommands,
    sourceDirectories,
    instructionFiles,
    configFiles,
    ...(gitignorePath === undefined ? {} : { gitignorePath }),
    cautions,
  };
}

function bulletList(values: string[], empty: string, code: boolean, newline: string): string {
  if (values.length === 0) return empty;
  return values.map((value) => `- ${code ? `\`${value}\`` : value}`).join(newline);
}

function renderGeneratedSection(facts: ProjectFacts, newline: string): string {
  const languages = facts.languages.length === 0 ? "not detected" : facts.languages.join(", ");
  const managers = facts.packageManagers.length === 0 ? "not detected" : facts.packageManagers.join(", ");
  const qualityCommands = [...facts.lintCommands, ...facts.formatCommands];
  const conventions = [
    ...facts.instructionFiles.map((file) => `Follow \`${file}\`.`),
    ...facts.configFiles.map((file) => `Respect \`${file}\`.`),
  ];
  const cautions = [
    "Do not read or copy secrets from environment files.",
    "Do not inspect dependency directories or generated output unless explicitly required.",
    ...facts.cautions,
  ];
  return [
    GENERATED_START,
    "## Overview",
    "",
    `- Project: ${facts.projectName}`,
    `- Languages: ${languages}`,
    `- Package manager: ${managers}`,
    "",
    "## Layout",
    "",
    bulletList(facts.sourceDirectories, "No conventional source directories detected.", true, newline),
    "",
    "## Build",
    "",
    bulletList(facts.buildCommands, "No verified build command detected.", true, newline),
    "",
    "## Test",
    "",
    bulletList(facts.testCommands, "No verified test command detected.", true, newline),
    "",
    "## Quality",
    "",
    bulletList(qualityCommands, "No verified lint or format command detected.", true, newline),
    "",
    "## Conventions",
    "",
    bulletList(conventions, "No additional project instruction or quality configuration files detected.", false, newline),
    "",
    "## Cautions",
    "",
    bulletList(cautions, "", false, newline),
    GENERATED_END,
  ].join(newline);
}

function detectNewline(text: string): string {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

function mergeGeneratedSection(existing: string | undefined, generated: string): string {
  if (existing === undefined || existing === "") return `${generated}\n`;
  const newline = detectNewline(existing);
  let searchFrom = 0;
  let lastPair: { start: number; end: number } | undefined;
  while (searchFrom < existing.length) {
    const start = existing.indexOf(GENERATED_START, searchFrom);
    if (start === -1) break;
    const end = existing.indexOf(GENERATED_END, start + GENERATED_START.length);
    if (end === -1) break;
    lastPair = { start, end };
    searchFrom = end + GENERATED_END.length;
  }
  if (lastPair !== undefined) {
    return `${existing.slice(0, lastPair.start)}${generated}${existing.slice(lastPair.end + GENERATED_END.length)}`;
  }
  const separator = existing.endsWith("\n") ? newline : `${newline}${newline}`;
  return `${existing}${separator}${generated}${newline}`;
}

async function addSessionsToGitignore(cwd: string): Promise<void> {
  const path = join(cwd, ".gitignore");
  const root = await realpath(cwd);
  await assertSafeManagedPath(path, root);
  let existing: string;
  try {
    existing = await readFile(path, "utf8");
  } catch (error) {
    if (!isMissingPathError(error)) throw error;
    existing = "";
  }
  const alreadyIgnored = existing.split(/\r?\n/).some((line) => {
    const normalized = line.trim().replace(/^\//, "").replace(/\/$/, "");
    return normalized === ".flavor/sessions";
  });
  if (alreadyIgnored) return;
  const newline = detectNewline(existing);
  const separator = existing === "" || existing.endsWith("\n") ? "" : newline;
  await writeFile(path, `${existing}${separator}.flavor/sessions/${newline}`);
}

async function assertSafeManagedPath(path: string, root: string): Promise<void> {
  try {
    const details = await lstat(path);
    if (details.isSymbolicLink()) {
      throw new Error(`Refusing to overwrite managed file symbolic link: ${path}`);
    }
    if (!isContainedPath(root, await realpath(path))) {
      throw new Error(`Refusing to overwrite managed file outside the project: ${path}`);
    }
  } catch (error) {
    if (isMissingPathError(error)) return;
    throw error;
  }
}

async function ensureFlavorDirectories(cwd: string): Promise<void> {
  const root = await realpath(cwd);
  const sessionsDir = join(cwd, ".flavor", "sessions");
  const skillsDir = join(cwd, ".flavor", "skills");
  await mkdir(sessionsDir, { recursive: true, mode: 0o700 });
  await mkdir(skillsDir, { recursive: true, mode: 0o700 });
  // Verify the created directories are safe
  const canonicalRoot = await realpath(root);
  for (const dir of [sessionsDir, skillsDir]) {
    const canonical = await realpath(dir);
    if (!isContainedPath(canonicalRoot, canonical)) {
      throw new Error(`Directory escapes the workspace: ${dir}`);
    }
  }
}

async function createExampleFlavorConfig(cwd: string): Promise<void> {
  const configPath = join(cwd, ".flavor", "flavor.json");
  const root = await realpath(cwd);
  await assertSafeManagedPath(configPath, root);
  try {
    await lstat(configPath);
    return; // Already exists, do not overwrite
  } catch (error) {
    if (!isMissingPathError(error)) throw error;
  }
  const example = {
    providers: {
      deepseek: {
        type: "anthropic",
        baseURL: "https://api.deepseek.com/anthropic",
        apiKey: "sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
        defaultModel: "deepseek-v4-pro",
        cheapModel: "deepseek-v4-flash",
      },
    },
    agents: {
      main: { model: "deepseek:deepseek-v4-pro" },
      subagent: { model: "deepseek:deepseek-v4-flash" },
    },
    maxSubagents: 3,
    permissionMode: "workspace",
    language: "zh-CN",
  };
  await writeFile(configPath, JSON.stringify(example, null, 2) + "\n");
}

export async function initializeFlavor(cwd: string): Promise<InitResult> {
  await ensureFlavorDirectories(cwd);
  await createExampleFlavorConfig(cwd);
  const facts = await inspectProject(cwd);
  const path = join(cwd, "FLAVOR.md");
  const root = await realpath(cwd);
  await assertSafeManagedPath(path, root);
  let existing: string | undefined;
  try {
    existing = await readFile(path, "utf8");
  } catch (error) {
    if (!isMissingPathError(error)) throw error;
  }
  const newline = existing === undefined ? "\n" : detectNewline(existing);
  const generated = renderGeneratedSection(facts, newline);
  const content = mergeGeneratedSection(existing, generated);
  await writeFile(path, content);
  await addSessionsToGitignore(cwd);
  return { path, created: existing === undefined, content, facts };
}
