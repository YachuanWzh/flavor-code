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
  let window = await application.firstWindow();
  await window.waitForLoadState("domcontentloaded");
  const hasBridge = await window.evaluate(() => typeof window.flavorDesktop?.openWorkspace === "function");
  if (!hasBridge) throw new Error("Electron preload bridge is unavailable");
  await window.evaluate((path) => window.flavorDesktop.openWorkspace(path), workspace);
  await window.getByRole("button", { name: basename(workspace), exact: true }).waitFor({ state: "visible" });
  await window.evaluate((path) => window.flavorDesktop.openWorkspace(path), secondWorkspace);
  await window.getByRole("button", { name: basename(secondWorkspace), exact: true }).waitFor({ state: "visible" });
  await window.getByRole("button", { name: basename(workspace), exact: true }).click();
  await window.getByText(basename(workspace), { exact: true }).last().waitFor({ state: "visible" });
  const sessionId = await window.evaluate(async () => (await window.flavorDesktop.startSession(undefined, "local")).sessionId);
  await window.evaluate(async () => window.flavorDesktop.listPals());
  await window.getByRole("button", { name: "Agent 工作台", exact: true }).click();
  await window.getByRole("heading", { name: "Agent 工作台" }).waitFor({ state: "visible" });
  await window.getByRole("button", { name: "代码图", exact: true }).waitFor({ state: "visible" });
  await window.getByRole("button", { name: "Pals", exact: true }).click();
  await window.locator(".pals-compose-grid").waitFor({ state: "visible" });
  const palCardLayout = await window.locator(".pal-compose-card").evaluateAll((cards) => cards.map((card) => {
    const bounds = card.getBoundingClientRect(); return { top: bounds.top, width: bounds.width, height: bounds.height };
  }));
  if (palCardLayout.length !== 2 || Math.abs(palCardLayout[0].top - palCardLayout[1].top) > 2 || palCardLayout.some((card) => card.width < 250 || card.height < 260)) throw new Error("Pal actions must render as two balanced desktop cards");
  if (process.env.FLAVOR_E2E_PALS_SCREENSHOT) await window.screenshot({ path: process.env.FLAVOR_E2E_PALS_SCREENSHOT });
  await window.getByRole("button", { name: "终端", exact: true }).click();
  await window.getByRole("button", { name: "＋ 新终端", exact: true }).click();
  await window.locator(".xterm-helper-textarea").waitFor({ state: "attached" });
  await window.waitForFunction(() => (document.querySelector(".xterm-rows")?.textContent?.length ?? 0) > 0);
  const terminalLabelFits = await window.locator(".terminal-layout aside strong").first().evaluate((element) => element.scrollWidth <= element.clientWidth);
  if (!terminalLabelFits) throw new Error("Terminal shell label must fit inside its sidebar item");
  const terminalLabel = await window.locator(".terminal-layout aside strong").first().textContent();
  if (terminalLabel?.includes("\\") || terminalLabel?.includes("/")) throw new Error("Terminal sidebar must present a compact shell name");
  const terminalId = await window.evaluate(async () => (await window.flavorDesktop.listTerminals()).find((terminal) => terminal.state === "running")?.id);
  if (terminalId === undefined) throw new Error("Interactive terminal did not open");
  await window.evaluate(async ({ id }) => window.flavorDesktop.writeTerminal(id, "node -e \"process.stdin.setRawMode(true);console.log('RAW_READY');process.stdin.once('data',d=>{console.log('KEY:'+d.toString('hex'));process.exit(0)})\"\r"), { id: terminalId });
  await window.waitForFunction(() => document.querySelector(".xterm-rows")?.textContent?.includes("RAW_READY") === true);
  await window.locator(".xterm-helper-textarea").focus();
  await window.keyboard.press("ArrowDown");
  await window.waitForFunction(() => document.querySelector(".xterm-rows")?.textContent?.includes("KEY:1b5b42") === true);
  await window.getByRole("button", { name: "关闭终端", exact: true }).click();
  await window.getByText("没有打开终端", { exact: true }).waitFor({ state: "visible" });
  if (await window.locator(".terminal-layout aside strong").count() !== 0) throw new Error("Closed terminal must leave the desktop terminal list");
  await window.getByRole("button", { name: "＋ 新终端", exact: true }).click();
  await window.locator(".xterm-helper-textarea").waitFor({ state: "attached" });
  const cliTerminalId = await window.evaluate(async () => (await window.flavorDesktop.listTerminals()).find((terminal) => terminal.state === "running")?.id);
  if (cliTerminalId === undefined) throw new Error("CLI verification terminal did not open");
  await window.evaluate(async ({ id, entry }) => window.flavorDesktop.writeTerminal(id, `node "${entry}"\r`), { id: cliTerminalId, entry: resolve("dist/cli.js") });
  await window.waitForFunction(() => document.querySelector(".xterm-rows")?.textContent?.includes("Quick commands") === true);
  await window.locator(".xterm-helper-textarea").focus();
  await window.keyboard.type("/help ", { delay: 35 });
  await window.keyboard.press("Enter");
  await window.waitForTimeout(1_000);
  const cliHelpOutput = await window.evaluate(async ({ id }) => (await window.flavorDesktop.readTerminal(id, 0)).output, { id: cliTerminalId });
  if (!cliHelpOutput.includes("/co-work") || !cliHelpOutput.includes("[reason]")) throw new Error(`Flavor CLI did not respond to terminal keyboard input: ${JSON.stringify(cliHelpOutput.slice(-2_000))}`);
  if (process.env.FLAVOR_E2E_TERMINAL_SCREENSHOT) await window.screenshot({ path: process.env.FLAVOR_E2E_TERMINAL_SCREENSHOT });
  await window.getByRole("button", { name: "关闭终端", exact: true }).click();
  await window.getByText("没有打开终端", { exact: true }).waitFor({ state: "visible" });
  await window.getByRole("button", { name: "‹" }).click();
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
  await application.close(); application = undefined;
  application = await electron.launch({
    args: [resolve("."), `--user-data-dir=${userData}`], cwd: resolve("."),
    env: { ...process.env, FLAVOR_DISABLE_UPDATE_CHECK: "1" }, timeout: 30_000,
  });
  window = await application.firstWindow(); await window.waitForLoadState("domcontentloaded");
  await window.evaluate(async ({ path, id }) => { await window.flavorDesktop.openWorkspace(path); await window.flavorDesktop.selectSession(id); }, { path: workspace, id: sessionId });
  await window.evaluate(async () => window.flavorDesktop.listPals());
  await window.getByRole("button", { name: "Agent 工作台", exact: true }).waitFor({ state: "visible" });
} finally {
  await application?.close().catch(() => undefined);
  await Promise.all([
    rm(workspace, { recursive: true, force: true }),
    rm(secondWorkspace, { recursive: true, force: true }),
    rm(userData, { recursive: true, force: true }),
  ]);
}
