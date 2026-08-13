import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { _electron as electron } from "playwright-core";

const workspace = await mkdtemp(join(tmpdir(), "flavor-electron-e2e-workspace-"));
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
  await window.getByRole("button", { name: /E2E/ }).click();
  await window.getByRole("heading", { name: "E2E" }).waitFor({ state: "visible" });
  const pipeline = window.getByLabel("E2E 从需求到成果物流程");
  if (await pipeline.locator("li").count() !== 7) throw new Error("E2E pipeline must render seven stages");
} finally {
  await application?.close().catch(() => undefined);
  await Promise.all([rm(workspace, { recursive: true, force: true }), rm(userData, { recursive: true, force: true })]);
}
