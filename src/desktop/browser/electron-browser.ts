/**
 * Production Electron glue for the BrowserHost. This is the ONLY browser file
 * that imports electron; unit tests construct BrowserHost with fakes instead.
 * Remote pages get a hardened webPreferences (no preload, no node, sandboxed)
 * inside a dedicated persistent partition (md_docs/todo.md sections 6, 7, 15).
 */

import { WebContentsView, session, type BrowserWindow } from "electron";

import { BrowserHost, type BrowserEventPayload } from "./browser-host.js";
import type { BrowserViewLike } from "./browser-tab.js";
import { validateBrowserNavigationUrl } from "./browser-security.js";

export const BROWSER_PARTITION = "persist:flavor-browser-default";

export interface ElectronBrowserHostOptions {
  getWindow: () => BrowserWindow | undefined;
  emit: (event: BrowserEventPayload) => void;
}

export function createElectronBrowserHost(options: ElectronBrowserHostOptions): BrowserHost {
  const partition = session.fromPartition(BROWSER_PARTITION);
  // Every device/origin permission is refused for browser content by default.
  partition.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  partition.setPermissionCheckHandler(() => false);
  // Downloads default to cancel until the enhanced approval flow exists.
  partition.on("will-download", (event) => {
    event.preventDefault();
  });

  return new BrowserHost({
    createView: () => {
      const view = new WebContentsView({
        webPreferences: {
          partition: BROWSER_PARTITION,
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
          webSecurity: true,
          devTools: false,
        },
      });
      // The same URL policy applies to renderer-initiated navigations and
      // redirects inside already-open documents.
      view.webContents.on("will-navigate", (event, targetUrl) => {
        if (!validateBrowserNavigationUrl(targetUrl).ok) event.preventDefault();
      });
      return view as unknown as BrowserViewLike;
    },
    attachView: (view) => {
      const window = options.getWindow();
      if (window !== undefined && !window.isDestroyed()) {
        window.contentView.addChildView(view as unknown as WebContentsView);
      }
    },
    detachView: (view) => {
      const window = options.getWindow();
      if (window !== undefined && !window.isDestroyed()) {
        window.contentView.removeChildView(view as unknown as WebContentsView);
      }
    },
    emit: options.emit,
  });
}
