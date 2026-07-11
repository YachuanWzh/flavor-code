import { spawn } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";

it.skipIf(process.platform === "win32")("routes two process SIGINTs through Stop, SessionEnd, and disposal", async () => {
  const root = await mkdtemp(join(tmpdir(), "flavor-sigint-")); const script = join(root, "child.mjs");
  const moduleUrl = pathToFileURL(resolve("src/ui/signals.ts")).href;
  await writeFile(script, `import { createSessionInterruptHandler, installSigintHandler } from ${JSON.stringify(moduleUrl)};
    let active = true;
    const session = { interrupt() {
      if (active) { active = false; console.log('Stop'); return 'cancelled'; }
      return 'exit';
    } };
    let cleanup;
    const handler = createSessionInterruptHandler(() => session, async () => {
      console.log('SessionEnd'); console.log('disposed'); cleanup(); setTimeout(() => process.exit(0), 0);
    });
    cleanup = installSigintHandler(process, handler); console.log('READY');
  `);
  const child = spawn(process.execPath, ["--experimental-strip-types", script], { stdio: ["ignore", "pipe", "pipe"] });
  let output = ""; child.stdout.setEncoding("utf8"); child.stdout.on("data", (chunk: string) => { output += chunk; });
  await waitFor(() => output.includes("READY")); child.kill("SIGINT");
  await waitFor(() => output.includes("Stop")); child.kill("SIGINT");
  const code = await new Promise<number | null>((resolvePromise, reject) => {
    child.once("exit", resolvePromise); child.once("error", reject);
  });
  expect(code).toBe(0);
  expect(output.match(/Stop|SessionEnd|disposed/g)).toEqual(["Stop", "SessionEnd", "disposed"]);
});

async function waitFor(predicate: () => boolean): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const deadline = Date.now() + 5_000;
    const check = () => {
      if (predicate()) resolvePromise();
      else if (Date.now() >= deadline) reject(new Error("Timed out waiting for child process output"));
      else setImmediate(check);
    };
    check();
  });
}
