import { dirname } from "node:path";

import { readRecoverableFile, updateProtectedFile } from "../config/protected-file.js";
import { decryptDocument, encryptDocument, loadOrCreateConfigKey } from "../config/secret-envelope.js";
import { D2cJudgeConfigInputSchema, type D2cJudgeConfig, type D2cJudgeConfigView } from "../d2c/judge.js";

export { D2cJudgeConfigInputSchema } from "../d2c/judge.js";
export type { D2cJudgeConfig, D2cJudgeConfigView } from "../d2c/judge.js";

export interface D2cJudgeConfigStore {
  load(): Promise<D2cJudgeConfig | undefined>;
  view(): Promise<D2cJudgeConfigView>;
  save(input: D2cJudgeConfig): Promise<D2cJudgeConfigView>;
}

function viewOf(config: D2cJudgeConfig | undefined): D2cJudgeConfigView {
  return config === undefined ? { configured: false } : {
    configured: true,
    protocol: config.protocol,
    baseURL: config.baseURL,
    model: config.model,
    passThreshold: config.passThreshold,
  };
}

export function createD2cJudgeConfigStore(path: string): D2cJudgeConfigStore {
  const decode = async (raw: string): Promise<D2cJudgeConfig> => {
    const key = await loadOrCreateConfigKey(dirname(path));
    return D2cJudgeConfigInputSchema.parse(decryptDocument(raw, key));
  };
  return {
    async load() {
      return (await readRecoverableFile(path, decode))?.value;
    },
    async view() {
      return viewOf(await this.load());
    },
    async save(input) {
      const parsed = D2cJudgeConfigInputSchema.parse(input);
      const key = await loadOrCreateConfigKey(dirname(path));
      const saved = await updateProtectedFile<D2cJudgeConfig>({
        path,
        decode,
        encode: (value) => encryptDocument(value, key),
        update: () => parsed,
      });
      return viewOf(saved);
    },
  };
}
