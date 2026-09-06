import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { dirname, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { getHeapStatistics } from "node:v8";

import React from "react";

import { Box, Text, renderSync } from "../src/claude-ink/index.js";
import { clearUiUserTimingEntries, installUiUserTimingSweeper } from "../src/ui/user-timing.js";

const FRAMES = 100_000;
const REPORT_PATH = resolve(process.env["FLAVOR_TUI_STRESS_REPORT"] ?? ".flavor/tmp/beta6-tui-memory-stress.json");

assert.equal(process.env.NODE_ENV, "development", "stress harness must load the development reconciler");
assert.equal(typeof console.timeStamp, "function", "stress harness must expose Node console.timeStamp()");
assert.equal(typeof globalThis.gc, "function", "stress harness requires --expose-gc");

const tree = (frame: number): React.ReactElement => React.createElement(
  Box,
  { flexDirection: "column" },
  ...Array.from({ length: 20 }, (_, index) => React.createElement(
    Text,
    { key: index },
    `frame ${frame} row ${index}`,
  )),
);

const stdout = Object.assign(new PassThrough(), { columns: 140, rows: 45, isTTY: true });
const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => undefined });
const stderr = new PassThrough();
stdout.resume();
stderr.resume();
const instance = renderSync(tree(0), {
  stdout: stdout as unknown as NodeJS.WriteStream,
  stdin: stdin as unknown as NodeJS.ReadStream,
  stderr: stderr as unknown as NodeJS.WriteStream,
  exitOnCtrlC: false,
  patchConsole: false,
});

let stopSweeper = (): void => undefined;
try {
  // Prove this process executes the exact leaking React 19 development path
  // from the beta.5 allocation profile, rather than a headless/RPC shortcut.
  for (let frame = 1; frame <= 250; frame += 1) instance.rerender(tree(frame));
  await immediate();
  const reproducedEntries = performance.getEntriesByType("measure").length;
  assert.ok(reproducedEntries > 1_000, `expected the incident path, observed only ${reproducedEntries} measures`);

  clearUiUserTimingEntries();
  forceGc();
  const startHeap = process.memoryUsage().heapUsed;
  let peakHeap = startHeap;
  const checkpoints: Array<{ frame: number; postGcHeapMb: number }> = [];
  stopSweeper = installUiUserTimingSweeper(5);
  for (let frame = 1; frame <= FRAMES; frame += 1) {
    instance.rerender(tree(frame));
    if (frame % 100 === 0) {
      await immediate();
      peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed);
    }
    if (frame % 10_000 === 0) {
      clearUiUserTimingEntries();
      forceGc();
      checkpoints.push({ frame, postGcHeapMb: toMb(process.memoryUsage().heapUsed) });
    }
  }
  await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 20));
  clearUiUserTimingEntries();
  forceGc();
  const postGcHeap = process.memoryUsage().heapUsed;
  const measures = performance.getEntriesByType("measure").length;
  const retainedDelta = postGcHeap - startHeap;
  const report = {
    version: "1.4.0-beta.6",
    frames: FRAMES,
    reproducedEntries,
    remainingMeasures: measures,
    heapLimitMb: Math.round(getHeapStatistics().heap_size_limit / 1_048_576),
    startHeapMb: toMb(startHeap),
    peakHeapMb: toMb(peakHeap),
    postGcHeapMb: toMb(postGcHeap),
    retainedDeltaMb: toMb(retainedDelta),
    checkpoints,
  };
  await mkdir(dirname(REPORT_PATH), { recursive: true });
  await writeFile(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(
    `[TUI] frames=${FRAMES} reproducedEntries=${reproducedEntries} measures=${measures} `
    + `heapLimit=${report.heapLimitMb}MB peak=${formatMb(peakHeap)} postGC=${formatMb(postGcHeap)} `
    + `retainedDelta=${formatMb(retainedDelta)} report=${REPORT_PATH}\n`,
  );
  assert.ok(measures < 500, `User Timing buffer retained ${measures} measures`);
  assert.ok(retainedDelta < 32 * 1024 * 1024, `Full-GC retained delta was ${formatMb(retainedDelta)}`);
} finally {
  stopSweeper();
  instance.unmount();
  instance.cleanup();
  clearUiUserTimingEntries();
}

function immediate(): Promise<void> {
  return new Promise((resolvePromise) => setImmediate(resolvePromise));
}

function forceGc(): void {
  globalThis.gc?.();
  globalThis.gc?.();
}

function toMb(bytes: number): number {
  return Number((bytes / 1_048_576).toFixed(1));
}

function formatMb(bytes: number): string {
  return `${toMb(bytes).toFixed(1)}MB`;
}
