import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

import { _electron as electron } from "playwright-core";

const workspace = await mkdtemp(join(tmpdir(), "flavor-electron-e2e-workspace-"));
const secondWorkspace = await mkdtemp(join(tmpdir(), "flavor-electron-e2e-second-"));
const userData = await mkdtemp(join(tmpdir(), "flavor-electron-e2e-userdata-"));
await mkdir(join(workspace, ".flavor"), { recursive: true });
execFileSync("git", ["init", "--quiet", workspace]);
execFileSync("git", ["-C", workspace, "config", "user.email", "desktop-e2e@flavor.local"]);
execFileSync("git", ["-C", workspace, "config", "user.name", "Flavor Desktop E2E"]);
await writeFile(join(workspace, "sample.ts"), "export const flavor = 'before';\n", "utf8");
execFileSync("git", ["-C", workspace, "add", "sample.ts"]);
execFileSync("git", ["-C", workspace, "commit", "--quiet", "-m", "initial"]);
await writeFile(join(workspace, "sample.ts"), "export const flavor = 'after';\nexport const desktop = true;\n", "utf8");
await Promise.all(Array.from({ length: 24 }, (_value, index) => writeFile(
  join(workspace, `scroll-check-${String(index + 1).padStart(2, "0")}.txt`), `file ${index + 1}\n`, "utf8",
)));
let application;
try {
  application = await electron.launch({
    args: [resolve("."), `--user-data-dir=${userData}`],
    cwd: resolve("."),
    env: { ...process.env, FLAVOR_DISABLE_UPDATE_CHECK: "1" },
    timeout: 30_000,
  });
  const window = await application.firstWindow();
  await window.waitForLoadState("domcontentloaded");
  const hasBridge = await window.evaluate(() => typeof window.flavorDesktop?.openWorkspace === "function");
  if (!hasBridge) throw new Error("Electron preload bridge is unavailable");
  await window.evaluate((path) => window.flavorDesktop.openWorkspace(path), workspace);
  await window.getByRole("button", { name: basename(workspace), exact: true }).waitFor({ state: "visible" });
  await window.evaluate((path) => window.flavorDesktop.openWorkspace(path), secondWorkspace);
  await window.getByRole("button", { name: basename(secondWorkspace), exact: true }).waitFor({ state: "visible" });
  await window.getByRole("button", { name: basename(workspace), exact: true }).click();
  await window.getByText(basename(workspace), { exact: true }).last().waitFor({ state: "visible" });
  await window.keyboard.press("Control+P");
  await window.getByPlaceholder("切换到项目…").waitFor({ state: "visible" });
  await window.keyboard.press("Escape");
  await window.keyboard.press("Control+K");
  await window.getByPlaceholder("键入命令…").waitFor({ state: "visible" });
  await window.keyboard.press("Escape");
  await window.getByRole("button", { name: /活动/ }).click();
  await window.getByRole("heading", { name: "活动" }).waitFor({ state: "visible" });
  await window.getByRole("button", { name: "Git 变更", exact: true }).click();
  await window.getByRole("heading", { name: "Git 变更" }).waitFor({ state: "visible" });
  const gitFiles = window.locator(".git-files");
  const scrollMetrics = await gitFiles.evaluate((element) => ({ clientHeight: element.clientHeight, scrollHeight: element.scrollHeight }));
  if (scrollMetrics.scrollHeight <= scrollMetrics.clientHeight) throw new Error("Git file list must have an internal scroll range");
  await gitFiles.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  if (await gitFiles.evaluate((element) => element.scrollTop) <= 0) throw new Error("Git file list must scroll independently");
  await gitFiles.evaluate((element) => { element.scrollTop = 0; });
  await window.getByRole("button", { name: /sample\.ts/ }).click();
  await window.getByLabel("sample.ts 差异").waitFor({ state: "visible" });
  await window.locator('.git-code-line[data-kind="addition"]').first().waitFor({ state: "visible" });
  if (await window.locator('.git-code-line[data-kind="addition"]').count() < 2) throw new Error("Git diff must render added lines");
  if (await window.locator('.git-code-line[data-kind="deletion"]').count() < 1) throw new Error("Git diff must render deleted lines");
  if (process.env.FLAVOR_E2E_SCREENSHOT) await window.screenshot({ path: process.env.FLAVOR_E2E_SCREENSHOT });
  await window.getByRole("button", { name: /E2E/ }).click();
  await window.getByRole("heading", { name: "E2E" }).waitFor({ state: "visible" });
  const pipeline = window.getByLabel("E2E 从需求到成果物流程");
  if (await pipeline.locator("li").count() !== 7) throw new Error("E2E pipeline must render seven stages");
} finally {
  await application?.close().catch(() => undefined);
  await Promise.all([
    rm(workspace, { recursive: true, force: true }),
    rm(secondWorkspace, { recursive: true, force: true }),
    rm(userData, { recursive: true, force: true }),
  ]);
}
