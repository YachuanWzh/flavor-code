import { describe, expect, it } from "vitest";

import { desktopWindowChrome } from "../../src/desktop/window-options.js";

describe("desktop window chrome", () => {
  it("uses a hidden title bar with native Windows controls over the custom header", () => {
    expect(desktopWindowChrome("win32")).toEqual({
      autoHideMenuBar: true,
      titleBarStyle: "hidden",
      titleBarOverlay: {
        color: "#edf3f9",
        symbolColor: "#26313c",
        height: 36,
      },
    });
  });
});
