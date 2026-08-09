import { Buffer } from "node:buffer";

import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";

export const D2C_MAX_PNG_BYTES = 32 * 1024 * 1024;
export const D2C_MAX_PIXELS = 8_388_608;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

export interface D2cPixelComparison {
  width: number;
  height: number;
  /** Fraction of mismatched pixels on the unified canvas, 0..1. */
  mismatchRate: number;
  heatmapPng: Buffer;
}

/** Reads only the PNG signature and IHDR dimensions, before allocating decoded RGBA buffers. */
export function assertPngDimensions(png: Buffer): { width: number; height: number } {
  if (png.byteLength > D2C_MAX_PNG_BYTES) throw new Error("PNG buffer exceeds the supported size");
  if (png.byteLength < 24 || !png.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)
    || png.toString("ascii", 12, 16) !== "IHDR") {
    throw new Error("Invalid PNG header");
  }
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  if (width === 0 || height === 0 || width * height > D2C_MAX_PIXELS) {
    throw new Error(`PNG dimensions exceed the supported pixel limit: ${width}x${height}`);
  }
  return { width, height };
}

/** Places the image top-left on a white canvas of the target size. */
function padToCanvas(image: PNG, width: number, height: number): PNG {
  if (image.width === width && image.height === height) return image;
  const canvas = new PNG({ width, height });
  canvas.data.fill(255);
  for (let y = 0; y < Math.min(image.height, height); y += 1) {
    const sourceStart = y * image.width * 4;
    const targetStart = y * width * 4;
    image.data.copy(canvas.data, targetStart, sourceStart, sourceStart + Math.min(image.width, width) * 4);
  }
  return canvas;
}

/**
 * Pixel-level comparison of two PNG buffers. The smaller image is padded with
 * white onto the larger canvas so size differences register as mismatches.
 */
export function comparePngs(leftPng: Buffer, rightPng: Buffer): D2cPixelComparison {
  if (leftPng.byteLength === 0 || rightPng.byteLength === 0) throw new Error("Empty PNG buffer");
  if (leftPng.byteLength > D2C_MAX_PNG_BYTES || rightPng.byteLength > D2C_MAX_PNG_BYTES) {
    throw new Error("PNG buffer exceeds the supported size");
  }
  assertPngDimensions(leftPng);
  assertPngDimensions(rightPng);
  const left = PNG.sync.read(leftPng);
  const right = PNG.sync.read(rightPng);
  const width = Math.max(left.width, right.width);
  const height = Math.max(left.height, right.height);
  if (width * height > D2C_MAX_PIXELS) throw new Error("Unified PNG canvas exceeds the supported pixel limit");
  const canvasLeft = padToCanvas(left, width, height);
  const canvasRight = padToCanvas(right, width, height);
  const heatmap = new PNG({ width, height });
  const mismatches = pixelmatch(canvasLeft.data, canvasRight.data, heatmap.data, width, height, { threshold: 0.1 });
  return {
    width,
    height,
    mismatchRate: mismatches / (width * height),
    heatmapPng: PNG.sync.write(heatmap),
  };
}
