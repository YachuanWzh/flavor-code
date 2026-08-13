import { parentPort } from "node:worker_threads";

import { comparePngs } from "./pixel.js";

if (parentPort === null) throw new Error("D2C pixel worker must run in a worker thread");

parentPort.on("message", (message: { left: Uint8Array; right: Uint8Array }) => {
  try {
    const result = comparePngs(Buffer.from(message.left), Buffer.from(message.right));
    parentPort!.postMessage({
      ok: true,
      result: { ...result, heatmapPng: new Uint8Array(result.heatmapPng) },
    });
  } catch (cause) {
    parentPort!.postMessage({
      ok: false,
      error: cause instanceof Error ? cause.message : String(cause),
    });
  }
});
