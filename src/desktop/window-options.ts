import type { BrowserWindowConstructorOptions } from "electron";

type DesktopWindowChrome = Pick<BrowserWindowConstructorOptions,
  "autoHideMenuBar" | "titleBarStyle" | "titleBarOverlay">;

export function desktopWindowChrome(platform: NodeJS.Platform = process.platform): DesktopWindowChrome {
  if (platform === "darwin") return {
    autoHideMenuBar: true,
    titleBarStyle: "hiddenInset",
    titleBarOverlay: false,
  };
  return {
    autoHideMenuBar: true,
    titleBarStyle: "hidden",
    titleBarOverlay: {
      color: "#edf3f9",
      symbolColor: "#26313c",
      height: 36,
    },
  };
}
