import { randomBytes, randomUUID } from "node:crypto";
import { chmod, link, mkdir, open, readFile, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const PAL_AUTH_TOKEN_BYTES = 32;
const TOKEN_PATTERN = /^[a-f0-9]{64}$/;

export interface PalAuthTokenOptions {
  home?: string;
  random?: (size: number) => Buffer;
}

export async function loadOrCreatePalAuthToken(options: PalAuthTokenOptions = {}): Promise<string> {
  const directory = join(options.home ?? homedir(), ".flavor-code", "pals");
  const tokenPath = join(directory, "auth-token");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const token = (options.random ?? randomBytes)(PAL_AUTH_TOKEN_BYTES).toString("hex");
  const temporaryPath = join(directory, `.auth-token-${process.pid}-${randomUUID()}.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    try {
      await handle.writeFile(`${token}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
      handle = undefined;
    }
    try {
      await link(temporaryPath, tokenPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  } finally {
    await handle?.close();
    await unlink(temporaryPath).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
  }
  const stored = (await readFile(tokenPath, "utf8")).trim();
  if (!TOKEN_PATTERN.test(stored)) throw new Error("Pals authentication token store is invalid");
  await chmod(tokenPath, 0o600);
  return stored;
}

export function validatePalAuthToken(token: string): string {
  if (!TOKEN_PATTERN.test(token)) throw new Error("Pals authentication token must be 32 bytes encoded as lowercase hex");
  return token;
}
