import { describe, expect, it, vi } from "vitest";

import { dispatchD2cTask } from "../../src/desktop/renderer/d2c-viewer.js";

describe("dispatchD2cTask", () => {
  it("records a pending task only after submit succeeds", async () => {
    const launch = vi.fn();
    await expect(dispatchD2cTask("prompt", "homepage", "vue", async () => true, launch)).resolves.toBe(true);
    expect(launch).toHaveBeenCalledWith("homepage", "vue");
  });

  it("does not record a pending task when submit fails", async () => {
    const launch = vi.fn();
    await expect(dispatchD2cTask("prompt", "homepage", "react", async () => false, launch)).resolves.toBe(false);
    expect(launch).not.toHaveBeenCalled();
  });
});
