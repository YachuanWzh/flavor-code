/* Temporary headless smoke: drives the real BrowserHost click path and
 * reports whether the in-page act overlay actually lands. Not part of the
 * shipped app; run via:  npx tsup scripts/overlay-smoke/main.ts --format cjs
 * --platform node --external electron --outDir .tmp-overlay-smoke && npx
 * electron .tmp-overlay-smoke/main.js */
import { app, BrowserWindow } from "electron";
import { writeFile } from "node:fs/promises";
import http from "node:http";
import { join } from "node:path";

import { createElectronBrowserHost } from "../../src/desktop/browser/electron-browser.js";

// Keep the smoke deterministic on Windows hosts whose GPU sandbox cannot
// initialize (the production app applies the same sandbox workaround).
app.commandLine.appendSwitch("disable-gpu-sandbox");
app.commandLine.appendSwitch("no-sandbox");
app.disableHardwareAcceleration();

const PAGE = `<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0">
<button id="b" style="position:absolute;left:120px;top:160px;width:200px;height:60px">Go</button>
<div id="log"></div>
<script>
document.getElementById('b').addEventListener('click', function(){ document.getElementById('log').textContent = 'clicked'; });
document.addEventListener('mousemove', function(e){ window.__lastMove = e.clientX + ',' + e.clientY; });
</script>
</body></html>`;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  await app.whenReady();
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(PAGE);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const win = new BrowserWindow({ show: true, width: 1200, height: 800 });
  const host = createElectronBrowserHost({
    getWindow: () => win,
    emit: (event) => console.log("EVENT", JSON.stringify(event)),
  });
  host.createSpace("s1");
  host.activateSpace("s1");
  const tab = host.newTab("s1", `http://127.0.0.1:${port}/`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const anyContent = win.contentView as any;
  const views = (anyContent.children ?? []).filter((child: any) => child.webContents !== undefined);
  const wc = views[views.length - 1].webContents as Electron.WebContents;
  await new Promise<void>((resolve) => {
    if (wc.getURL() !== "" && !wc.isLoading()) resolve();
    else wc.once("did-finish-load", () => resolve());
  });
  host.setBounds("s1", { x: 0, y: 0, width: 800, height: 600 });
  host.setPanelVisible("s1", true);
  // Headless windows may expose no AX nodes; register a ref manually via DOM.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const realTab = (host as any).state("s1").tabs.get(tab.id);
  const commander = realTab.cdp();
  if (commander === undefined) { console.log("NO-CDP"); app.exit(2); return; }
  await commander.sendCommand("DOM.enable", {}, {});
  const doc = await commander.sendCommand("DOM.getDocument", {}, {});
  const found = await commander.sendCommand("DOM.querySelector",
    { nodeId: doc.root.nodeId, selector: "#b" }, {});
  const described = await commander.sendCommand("DOM.describeNode", { nodeId: found.nodeId }, {});
  const backendNodeId = described.node.backendNodeId as number;
  console.log("FOUND_NODE", JSON.stringify(found), "BACKEND", backendNodeId);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const registry = (host as any).registryFor("s1", tab.id);
  registry.replaceDocument("smoke-doc", [{
    frameId: "main", backendNodeId, role: "button", name: "Go",
  }]);
  const actPromise = host.act("s1", tab.id, { action: "click", ref: 1 });
  await delay(250);
  const midFlight = await wc.executeJavaScript(`(function () {
    var f = document.getElementById("__flavor_act_overlay__")?.__f;
    return f ? getComputedStyle(f.cur).transform : "NO-CURSOR";
  })()`);
  console.log("CURSOR_MID_FLIGHT", midFlight);
  const actResult = await actPromise;
  console.log("ACT_RESULT", JSON.stringify(actResult));
  await delay(150);
  const overlay = await wc.executeJavaScript(`(function () {
    var h = document.getElementById("__flavor_act_overlay__");
    if (!h) return "NO-OVERLAY-HOST";
    var f = h.__f;
    if (!f) return "NO-OVERLAY-API";
    return JSON.stringify({
      curClass: f.cur.className,
      curTransform: f.cur.style.transform,
      ripClass: f.rip.className,
      hlClass: f.hl.className,
      connected: h.isConnected,
      shadowVisible: getComputedStyle(h).zIndex,
    });
  })()`);
  console.log("OVERLAY_STATE", overlay);
  const screenshotPath = join(app.getPath("temp"), "flavor-overlay-smoke.png");
  await writeFile(screenshotPath, (await wc.capturePage()).toPNG());
  console.log("OVERLAY_SCREENSHOT", screenshotPath);
  console.log("PAGE_LOG", await wc.executeJavaScript("document.getElementById('log').textContent"));
  console.log("LAST_MOUSEMOVE", await wc.executeJavaScript("window.__lastMove || 'none'"));
  server.close();
  app.exit(0);
}

main().catch((error: unknown) => {
  console.error("SMOKE-FAIL", error);
  app.exit(1);
});
