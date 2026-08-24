import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

import { _electron as electron } from "playwright-core";

const workspace = await mkdtemp(join(tmpdir(), "flavor-electron-e2e-workspace-"));
const secondWorkspace = await mkdtemp(join(tmpdir(), "flavor-electron-e2e-second-"));
const userData = await mkdtemp(join(tmpdir(), "flavor-electron-e2e-userdata-"));
await mkdir(join(workspace, ".flavor"), { recursive: true });
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
