import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdir, open, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const FIELD_PREFIX = "flavor:v1:";
const FILE_PREFIX = "flavor-file:v1:";
const KEY_BYTES = 32;

export function isSecretField(key: string): boolean {
  const normalized = key.replace(/[-_.]/g, "").toLowerCase();
  return ["apikey", "authorization", "token", "password", "secret"]
    .some((suffix) => normalized.endsWith(suffix));
}

export function hasPlainSecretFields(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasPlainSecretFields);
  if (!isObject(value)) return false;
  return Object.entries(value).some(([key, item]) =>
    (isSecretField(key) && typeof item === "string" && !item.startsWith(FIELD_PREFIX))
    || hasPlainSecretFields(item),
  );
}

export function hasEncryptedSecretFields(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasEncryptedSecretFields);
  if (!isObject(value)) return false;
  return Object.entries(value).some(([key, item]) =>
    (isSecretField(key) && typeof item === "string" && item.startsWith(FIELD_PREFIX))
    || hasEncryptedSecretFields(item),
  );
}

export function encryptSecretFields(value: unknown, key: Buffer): unknown {
  if (Array.isArray(value)) return value.map((item) => encryptSecretFields(item, key));
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([name, item]) => [
    name,
    isSecretField(name) && typeof item === "string"
      ? (item.startsWith(FIELD_PREFIX) ? item : `${FIELD_PREFIX}${seal(item, key)}`)
      : encryptSecretFields(item, key),
  ]));
}

export function decryptSecretFields(value: unknown, key: Buffer): unknown {
  if (Array.isArray(value)) return value.map((item) => decryptSecretFields(item, key));
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([name, item]) => [
    name,
    isSecretField(name) && typeof item === "string" && item.startsWith(FIELD_PREFIX)
      ? openEnvelope(item.slice(FIELD_PREFIX.length), key)
      : decryptSecretFields(item, key),
  ]));
}

export function encryptDocument(value: unknown, key: Buffer): string {
  return JSON.stringify(`${FILE_PREFIX}${seal(JSON.stringify(value), key)}`);
}

export function decryptDocument(raw: string, key: Buffer): unknown {
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed === "string" && parsed.startsWith(FILE_PREFIX)) {
    return JSON.parse(openEnvelope(parsed.slice(FILE_PREFIX.length), key)) as unknown;
  }
  return parsed;
}

export async function loadOrCreateConfigKey(directory: string): Promise<Buffer> {
  const path = join(directory, ".config.key");
  try {
    return parseKey(await readFile(path, "utf8"));
  } catch (error) {
    if (!isCode(error, "ENOENT")) throw error;
  }
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const key = randomBytes(KEY_BYTES);
  let handle;
  try {
    handle = await open(path, "wx", 0o600);
    await handle.writeFile(`${key.toString("base64")}\n`, "utf8");
    await handle.sync();
    return key;
  } catch (error) {
    if (!isCode(error, "EEXIST")) throw error;
    return parseKey(await readFile(path, "utf8"));
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function seal(plaintext: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), ciphertext].map((part) => part.toString("base64")).join(":");
}

function openEnvelope(envelope: string, key: Buffer): string {
  const parts = envelope.split(":");
  if (parts.length !== 3) throw new Error("Invalid encrypted value envelope");
  const [ivText, tagText, ciphertextText] = parts as [string, string, string];
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivText, "base64"));
    decipher.setAuthTag(Buffer.from(tagText, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertextText, "base64")),
      decipher.final(),
    ]).toString("utf8");
  } catch (error) {
    throw new Error(`Encrypted value failed authentication: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function parseKey(raw: string): Buffer {
  const key = Buffer.from(raw.trim(), "base64");
  if (key.length !== KEY_BYTES) throw new Error("Invalid Flavor configuration key");
  return key;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error
    && (error as NodeJS.ErrnoException).code === code;
}
