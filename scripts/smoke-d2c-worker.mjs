import { Worker } from "node:worker_threads";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { PNG } from "pngjs";

const image = new PNG({ width: 2, height: 2 });
image.data.fill(255);
const png = PNG.sync.write(image);
const workerUrl = process.argv[2] === undefined
  ? new URL("../dist/desktop/pixel-worker.js", import.meta.url)
  : pathToFileURL(resolve(process.argv[2]));
const worker = new Worker(workerUrl);
const result = await new Promise((resolve, reject) => {
  worker.once("message", resolve);
  worker.once("error", reject);
  worker.postMessage({ left: new Uint8Array(png), right: new Uint8Array(png) });
});
await worker.terminate();

if (result?.ok !== true || result.result?.mismatchRate !== 0) {
  throw new Error(`D2C pixel worker smoke test failed: ${JSON.stringify(result)}`);
}
console.log(`D2C pixel worker OK (${result.result.width}x${result.result.height})`);
