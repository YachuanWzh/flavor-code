import { createHash } from "node:crypto";

export interface PalSocketAddressOptions {
  platform: NodeJS.Platform;
  userScope: string;
  runtimeDir: string;
}

function opaqueUserScope(userScope: string): string {
  if (userScope.length === 0) throw new Error("User scope must not be empty");
  const digest = createHash("sha256").update(userScope, "utf8").digest("hex").slice(0, 16);
  return `u-${digest}`;
}

export function palSocketAddress(options: PalSocketAddressOptions): string {
  if (options.platform === "win32") {
    return `\\\\.\\pipe\\flavor-code-pals-${opaqueUserScope(options.userScope)}-v1`;
  }

  const runtimeDir = options.runtimeDir.replace(/[\\/]+$/, "");
  if (runtimeDir.length === 0) throw new Error("Runtime directory must not be empty");
  return `${runtimeDir}/pals-v1.sock`;
}
