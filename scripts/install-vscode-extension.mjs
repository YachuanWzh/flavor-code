import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { createVSIX } = require("@vscode/vsce");

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "..");
const extensionDirectory = join(repositoryRoot, "extensions", "vscode");
const extensionId = "flavor-code.flavor-code";

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function parseIde(argv) {
  const index = argv.indexOf("--ide");
  const value = index >= 0 ? argv[index + 1] : "auto";
  if (!value || !["auto", "qoder", "code"].includes(value)) {
    throw new Error("--ide must be one of: auto, qoder, code");
  }
  return value;
}

function commandCandidates(ide) {
  if (ide === "qoder") return ["qoder"];
  if (ide === "code") return ["code"];
  return ["qoder", "code"];
}

function quoteWindowsBatchArgument(value) {
  return `"${String(value).replaceAll("%", "%%").replaceAll('"', '""')}"`;
}

function run(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const useCommandShell = process.platform === "win32" && /\.(cmd|bat)$/i.test(command);
    const executable = useCommandShell ? process.env.ComSpec || "cmd.exe" : command;
    const executableArgs = useCommandShell
      ? [
          "/d",
          "/s",
          "/c",
          ["call", quoteWindowsBatchArgument(command), ...args.map(quoteWindowsBatchArgument)].join(" "),
        ]
      : args;
    const child = spawn(executable, executableArgs, {
      cwd: repositoryRoot,
      env: process.env,
      stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
      windowsHide: true,
      windowsVerbatimArguments: useCommandShell,
    });

    let stdout = "";
    let stderr = "";
    if (options.capture) {
      child.stdout?.on("data", (chunk) => { stdout += chunk; });
      child.stderr?.on("data", (chunk) => { stderr += chunk; });
    }
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolvePromise({ stdout, stderr });
      } else {
        const details = options.capture ? `\n${stdout}${stderr}`.trimEnd() : "";
        reject(new Error(`${command} exited with code ${code}${details}`));
      }
    });
  });
}

async function resolveCommand(name) {
  const locator = process.platform === "win32" ? "where.exe" : "which";
  try {
    const { stdout } = await run(locator, [name], { capture: true });
    const paths = stdout.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
    if (process.platform === "win32") {
      return paths.find((path) => /\.(cmd|bat|exe)$/i.test(path)) ?? paths[0];
    }
    return paths[0];
  } catch {
    return undefined;
  }
}

async function findIdeCommand(ide) {
  for (const candidate of commandCandidates(ide)) {
    const command = await resolveCommand(candidate);
    if (command) return { command, name: candidate };
  }
  const expected = commandCandidates(ide).join(" or ");
  throw new Error(`Could not find ${expected} on PATH.`);
}

async function main() {
  const requestedIde = parseIde(process.argv.slice(2));
  const rootPackage = readJson(join(repositoryRoot, "package.json"));
  const extensionPackage = readJson(join(extensionDirectory, "package.json"));
  if (rootPackage.version !== extensionPackage.version) {
    throw new Error(
      `Version mismatch: package.json is ${rootPackage.version}, `
      + `extensions/vscode/package.json is ${extensionPackage.version}.`,
    );
  }

  const ide = await findIdeCommand(requestedIde);
  const npm = await resolveCommand("npm");
  if (!npm) throw new Error("Could not find npm on PATH.");

  console.log(`\nBuilding Flavor Code ${extensionPackage.version}...\n`);
  await run(npm, ["run", "build:icons"]);
  await run(npm, ["run", "build:cli"]);
  await run(npm, ["run", "vscode:typecheck"]);
  await run(npm, ["run", "vscode:build"]);

  const releaseDirectory = join(repositoryRoot, "release");
  mkdirSync(releaseDirectory, { recursive: true });
  const vsixPath = join(
    releaseDirectory,
    `flavor-code-vscode-${extensionPackage.version}.vsix`,
  );

  console.log(`\nPackaging ${vsixPath}...\n`);
  await createVSIX({ cwd: extensionDirectory, packagePath: vsixPath });
  if (!existsSync(vsixPath)) throw new Error(`VSIX was not created: ${vsixPath}`);

  console.log(`\nInstalling into ${ide.name === "qoder" ? "Qoder" : "VS Code"}...\n`);
  await run(ide.command, ["--install-extension", vsixPath, "--force"]);

  const { stdout } = await run(
    ide.command,
    ["--list-extensions", "--show-versions"],
    { capture: true },
  );
  const expected = `${extensionId}@${extensionPackage.version}`.toLowerCase();
  const installed = stdout.split(/\r?\n/u).some((line) => line.trim().toLowerCase() === expected);
  if (!installed) {
    throw new Error(`Installation finished, but ${expected} was not reported by ${ide.name}.`);
  }

  const productName = ide.name === "qoder" ? "Qoder" : "VS Code";
  console.log(`\n✓ Flavor Code ${extensionPackage.version} is installed in ${productName}.`);
  console.log(`  VSIX: ${vsixPath}`);
  console.log(`  If ${productName} is open, run “Developer: Reload Window” once.\n`);
}

main().catch((error) => {
  console.error(`\nInstallation failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
