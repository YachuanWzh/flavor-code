import { Buffer } from "node:buffer";

import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";

import { assertPngDimensions, comparePngs, D2C_MAX_PIXELS } from "../../src/d2c/pixel.js";

function png(width: number, height: number, fill: (x: number, y: number) => [number, number, number]): Buffer {
  const image = new PNG({ width, height });
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = fill(x, y);
      const index = (width * y + x) << 2;
      image.data[index] = r;
      image.data[index + 1] = g;
      image.data[index + 2] = b;
      image.data[index + 3] = 255;
    }
  }
  return PNG.sync.write(image);
}

const red = () => [255, 0, 0] as [number, number, number];

describe("comparePngs", () => {
  it("reports zero mismatch for identical images", () => {
    const image = png(4, 4, red);
    const result = comparePngs(image, image);
    expect(result.mismatchRate).toBe(0);
    expect(result.width).toBe(4);
    expect(result.height).toBe(4);
    expect(result.heatmapPng.byteLength).toBeGreaterThan(8);
  });

  it("counts a single differing pixel out of four", () => {
    const a = png(2, 2, red);
    const b = png(2, 2, (x, y) => (x === 0 && y === 0 ? [0, 0, 255] : [255, 0, 0]));
    const result = comparePngs(a, b);
    expect(result.mismatchRate).toBeCloseTo(0.25, 5);
  });

  it("pads the smaller image with white onto the larger canvas", () => {
    const small = png(2, 2, red);
    const large = png(3, 3, red);
    const result = comparePngs(small, large);
    expect(result.width).toBe(3);
    expect(result.height).toBe(3);
    // Five padded white pixels differ from the red 3x3 canvas.
    expect(result.mismatchRate).toBeCloseTo(5 / 9, 5);
  });

  it("rejects empty or oversized buffers", () => {
    const valid = png(2, 2, red);
    expect(() => comparePngs(Buffer.alloc(0), valid)).toThrow();
    expect(() => comparePngs(valid, Buffer.alloc(0))).toThrow();
  });

  it("rejects decompression-bomb dimensions before decoding pixel data", () => {
    const header = Buffer.alloc(24);
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(header);
    header.write("IHDR", 12, "ascii");
    header.writeUInt32BE(8192, 16);
    header.writeUInt32BE(8192, 20);
    expect(() => assertPngDimensions(header)).toThrow(/pixel|dimension|size/i);
    expect(D2C_MAX_PIXELS).toBeLessThan(8192 * 8192);
  });
});
