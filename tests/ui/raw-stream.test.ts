import { describe, expect, it } from "vitest";
import { PassThrough } from "node:stream";

import { createRawStream } from "../../src/ui/raw-stream.js";

/**
 * `RawStream` writes raw ANSI bytes to a `WriteStream`. Wrap a PassThrough
 * stream so we can capture what was emitted without touching real stdout.
 */
function captureStream(columns: number): { stdout: PassThrough; stream: ReturnType<typeof createRawStream>; read: () => string } {
  const stdout = new PassThrough();
  let buffer = "";
  stdout.on("data", (chunk: Buffer | string) => { buffer += chunk.toString(); });
  const stream = createRawStream({ stdout: stdout as unknown as NodeJS.WriteStream, topRow: 2, columns });
  return { stdout, stream, read: () => buffer };
}

describe("createRawStream", () => {
  it("auto-starts on the first append so callers don't need a separate setup", () => {
    // The hot path is "user submitted a prompt, text events arrive"; we
    // don't want callers to coordinate a start() event manually.
    const { stream, read } = captureStream(40);
    expect(stream.active).toBe(false);
    stream.append("hello");
    expect(stream.active).toBe(true);
    const out = read();
    expect(out).toContain("\x1B[2;1H");
    expect(out).toContain("hello");
  });

  it("start() then append positions the cursor via absolute moves", () => {
    const { stream, read } = captureStream(40);
    stream.start();
    stream.append("hello");
    const out = read();
    // First write at top of band: position cursor at (2, 1), then write
    expect(out).toContain("\x1B[2;1H");
    expect(out).toContain("hello");
    expect(stream.active).toBe(true);
  });

  it("reset() discards the in-progress stream", () => {
    const { stream } = captureStream(40);
    stream.start();
    stream.append("oh no");
    stream.reset();
    expect(stream.active).toBe(false);
    expect(stream.finalize()).toBe("");
  });

  it("finalize() returns the accumulated text and locks the cursor back", () => {
    const { stream, read } = captureStream(40);
    stream.start();
    stream.append("ab");
    stream.append("cd");
    const full = stream.finalize();
    expect(full).toBe("abcd");
    expect(stream.active).toBe(false);
    expect(read()).toContain("\x1B[2;1H");
  });

  it("wraps the virtual cursor when columns are exceeded", () => {
    const second = captureStream(5);
    second.stream.start();
    second.stream.append("abcde");
    // 5 chars fills row 0 of the band; cursor advances past the right edge.
    second.stream.append("f");
    // 'f' wraps to the next line.
    second.stream.append("g");
    // 'g' follows on the same wrapped line.
    const out = second.read();
    expect(out).toContain("\x1B[3;2H");
    expect(out).toContain("g");
  });

  it("advances 2 columns for CJK characters", () => {
    const { stream, read } = captureStream(40);
    stream.start();
    stream.append("你好"); // 2 CJK chars, 4 visual columns
    stream.append("X");
    const out = read();
    // 'X' should be positioned at (2, 5) — after 4 columns of CJK
    expect(out).toContain("\x1B[2;5H");
    expect(out).toContain("X");
  });

  it("clamps cursorRow when maxRows is set", () => {
    const stdout = new PassThrough();
    let buffer = "";
    stdout.on("data", (chunk: Buffer | string) => { buffer += chunk.toString(); });
    const stream = createRawStream({ stdout: stdout as unknown as NodeJS.WriteStream, topRow: 2, columns: 40, maxRows: 3 });
    stream.start();
    stream.append("line1\nline2\nline3\nline4\nline5");
    stream.append("safe");
    // cursorRow should never exceed maxRows-1 = 2, so the highest
    // absolute row in the ANSI escape is topRow+2 = 4.
    expect(buffer).not.toContain("\x1B[5;");
    expect(buffer).toContain("safe");
  });

  it("advances to column 1 on newline characters", () => {
    const { stream, read } = captureStream(20);
    stream.start();
    stream.append("hi\nthere");
    // The first chunk is written as a single `stdout.write` from (2, 1);
    // the terminal wraps the newline on its own. The virtual cursor
    // should end up at the start of the next row.
    stream.append("again");
    // 'again' must position at (3, 6) — end of 'there'.
    const out = read();
    expect(out).toContain("\x1B[3;6H");
    expect(out).toContain("again");
  });
});
