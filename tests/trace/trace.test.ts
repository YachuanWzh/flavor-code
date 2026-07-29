import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { TraceRecorder } from "../../src/trace/recorder.js";
import { replayOutputEvents, replayTrace } from "../../src/trace/replay.js";

describe("trace recording and replay", () => {
  it("writes monotonic redacted records and replays output events", async () => {
    const root = await mkdtemp(join(tmpdir(), "flavor-trace-"));
    const path = join(root, "trace.jsonl");
    const recorder = new TraceRecorder({ path, sessionId: "session-test", secrets: ["top-secret"] });
    await recorder.record("command", { type: "prompt", apiKey: "top-secret" });
    await recorder.record("output", { type: "text", text: "hello" });
    await recorder.close();

    const raw = await readFile(path, "utf8");
    expect(raw).not.toContain("top-secret");
    const records = await replayTrace(path);
    expect(records.map((record) => record.sequence)).toEqual([1, 2]);
    expect(records.filter((record) => record.kind === "output").map((record) => record.payload))
      .toEqual([{ type: "text", text: "hello" }]);
    const output = [];
    for await (const event of replayOutputEvents(path)) output.push(event);
    expect(output).toEqual([{ type: "text", text: "hello" }]);
  });
});
