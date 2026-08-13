import { Worker } from "node:worker_threads";

import type { D2cPixelComparison } from "./pixel.js";

/** Runs the synchronous PNG decoder and pixelmatch outside the Electron main thread. */
export function comparePngsInWorker(
  left: Buffer,
  right: Buffer,
  signal?: AbortSignal,
): Promise<D2cPixelComparison> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./pixel-worker.js", import.meta.url));
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      void worker.terminate();
      callback();
    };
    const onAbort = (): void => finish(() => reject(signal?.reason ?? new Error("D2C comparison cancelled")));
    signal?.addEventListener("abort", onAbort, { once: true });
    worker.once("message", (message: unknown) => {
      const value = message as {
        ok?: boolean;
        error?: string;
        result?: Omit<D2cPixelComparison, "heatmapPng"> & { heatmapPng: Uint8Array };
      };
      if (value.ok !== true || value.result === undefined) {
        finish(() => reject(new Error(value.error ?? "D2C pixel worker failed")));
        return;
      }
      finish(() => resolve({ ...value.result!, heatmapPng: Buffer.from(value.result!.heatmapPng) }));
    });
    worker.once("error", (error) => finish(() => reject(error)));
    worker.once("exit", (code) => {
      if (!settled && code !== 0) finish(() => reject(new Error(`D2C pixel worker exited with code ${code}`)));
    });
    worker.postMessage({ left: new Uint8Array(left), right: new Uint8Array(right) });
  });
}
