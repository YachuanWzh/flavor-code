import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

import type { ModelImageContentBlock, ModelImageMediaType } from "../models/types.js";

export const DEFAULT_MAX_IMAGES = 5;
export const DEFAULT_MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const DEFAULT_MAX_TOTAL_IMAGE_BYTES = 20 * 1024 * 1024;

const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export interface ImageAttachmentInput {
  name: string;
  mediaType: ModelImageMediaType;
  dataBase64: string;
}

export interface SessionAssetStoreOptions {
  workspace: string;
  maxImages?: number;
  maxImageBytes?: number;
  maxTotalBytes?: number;
}

export class SessionAssetStore {
  readonly #root: string;
  readonly #maxImages: number;
  readonly #maxImageBytes: number;
  readonly #maxTotalBytes: number;

  constructor(options: SessionAssetStoreOptions) {
    this.#root = join(resolve(options.workspace), ".flavor", "session-assets");
    this.#maxImages = positiveInteger(options.maxImages ?? DEFAULT_MAX_IMAGES, "maxImages");
    this.#maxImageBytes = positiveInteger(options.maxImageBytes ?? DEFAULT_MAX_IMAGE_BYTES, "maxImageBytes");
    this.#maxTotalBytes = positiveInteger(options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_IMAGE_BYTES, "maxTotalBytes");
  }

  async store(sessionId: string, inputs: readonly ImageAttachmentInput[]): Promise<ModelImageContentBlock[]> {
    if (!SESSION_ID.test(sessionId)) throw new Error("Invalid session id");
    if (inputs.length > this.#maxImages) {
      throw new Error(`A prompt can contain at most ${this.#maxImages} images`);
    }
    const decoded = inputs.map((input) => decodeAttachment(input, this.#maxImageBytes));
    const total = decoded.reduce((sum, item) => sum + item.data.byteLength, 0);
    if (total > this.#maxTotalBytes) {
      throw new Error(`Image attachments exceed the maximum total size of ${this.#maxTotalBytes} bytes`);
    }
    if (decoded.length === 0) return [];

    const directory = join(this.#root, sessionId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const output: ModelImageContentBlock[] = [];
    for (const item of decoded) {
      const sha256 = createHash("sha256").update(item.data).digest("hex");
      const target = join(directory, `${sha256}${extension(item.mediaType)}`);
      await writeOnce(target, item.data);
      output.push({
        type: "image",
        source: { type: "file", path: target },
        mediaType: item.mediaType,
        sha256,
        bytes: item.data.byteLength,
        name: safeName(item.name),
      });
    }
    return output;
  }
}

function decodeAttachment(input: ImageAttachmentInput, maxBytes: number): ImageAttachmentInput & { data: Buffer } {
  if (!input.name || input.name.length > 255) throw new Error("Image name must be between 1 and 255 characters");
  if (!["image/png", "image/jpeg", "image/webp"].includes(input.mediaType)) {
    throw new Error(`Unsupported image media type: ${String(input.mediaType)}`);
  }
  if (!input.dataBase64 || !BASE64.test(input.dataBase64)) throw new Error("Image data is not valid base64");
  const data = Buffer.from(input.dataBase64, "base64");
  if (data.toString("base64") !== input.dataBase64) throw new Error("Image data is not canonical base64");
  if (data.byteLength > maxBytes) throw new Error(`Image exceeds the maximum size of ${maxBytes} bytes`);
  const detected = detectMediaType(data);
  if (detected !== input.mediaType) {
    throw new Error(`Image media type ${input.mediaType} does not match file bytes`);
  }
  return { ...input, data };
}

function detectMediaType(data: Buffer): ModelImageMediaType | undefined {
  if (data.length >= 8
    && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "image/png";
  }
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "image/jpeg";
  if (data.length >= 12 && data.subarray(0, 4).toString("ascii") === "RIFF"
    && data.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return undefined;
}

function extension(mediaType: ModelImageMediaType): string {
  if (mediaType === "image/png") return ".png";
  if (mediaType === "image/jpeg") return ".jpg";
  return ".webp";
}

function safeName(name: string): string {
  return basename(name).replace(/[\u0000-\u001f\u007f]/g, "_").slice(0, 255) || "image";
}

async function writeOnce(target: string, data: Buffer): Promise<void> {
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    await handle.writeFile(data);
    await handle.sync();
    await handle.close();
    handle = undefined;
    try {
      await rename(temporary, target);
    } catch (error) {
      if (!isCode(error, "EEXIST") && !isCode(error, "EPERM")) throw error;
    }
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

function isCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error
    && (error as { code?: unknown }).code === code;
}
