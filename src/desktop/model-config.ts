import { loadConfig, setGlobalProviderConfig, setProjectProviderConfig } from "../config/load.js";
import type { ProviderConfig } from "../config/schema.js";
import type { AddDesktopModelInput, DesktopModelOption } from "./contracts.js";
import { createFileTokenStore } from "../auth/store.js";
import { join } from "node:path";

export const DEFAULT_DESKTOP_MODELS: readonly DesktopModelOption[] = [
  {
    id: "anthropic:deepseek-v4-pro",
    provider: "anthropic",
    model: "deepseek-v4-pro",
    label: "DeepSeek V4 Pro",
    description: "复杂任务与深度推理",
    source: "built-in",
  },
  {
    id: "anthropic:deepseek-v4-flash",
    provider: "anthropic",
    model: "deepseek-v4-flash",
    label: "DeepSeek V4 Flash",
    description: "快速响应与轻量任务",
    source: "built-in",
  },
];

export async function loadDesktopModels(workspace: string, home: string): Promise<DesktopModelOption[]> {
  try {
    const tokens = await createFileTokenStore(join(home, ".flavor-code", "auth.json")).load();
    const pkceModels: DesktopModelOption[] = [];
    const knownPkce = new Set<string>();
    for (const token of Object.values(tokens)) {
      if (token.llmConfig === undefined || new Date(token.expiresAt).getTime() <= Date.now()) continue;
      for (const model of token.llmConfig.models) {
        const id = `${token.llmConfig.providerId}:${model}`;
        if (knownPkce.has(id)) continue;
        knownPkce.add(id);
        pkceModels.push({
          id,
          provider: token.llmConfig.providerId,
          model,
          label: `${token.llmConfig.serviceName} · ${model}`,
          description: `PKCE · ${protocolLabel(token.llmConfig.apiType)}`,
          source: "custom",
        });
      }
    }
    if (pkceModels.length > 0) return pkceModels;
  } catch {
    // A damaged credential cache is reported by runtime authentication; model
    // discovery can still fall back to project configuration here.
  }
  const { config } = await loadConfig({ cwd: workspace, home });
  const models = [...DEFAULT_DESKTOP_MODELS];
  const known = new Set(models.map((model) => model.id));
  for (const [provider, providerConfig] of Object.entries(config.providers)) {
    const configuredModels = providerConfig.models
      ?? [providerConfig.defaultModel, providerConfig.cheapModel]
        .filter((model): model is string => typeof model === "string");
    for (const model of configuredModels) {
      const id = `${provider}:${model}`;
      if (known.has(id)) continue;
      known.add(id);
      models.push({
        id,
        provider,
        model,
        label: model,
        description: `${provider} · ${protocolLabel(providerConfig.type)}`,
        source: "custom",
      });
    }
  }
  return models;
}

export async function saveDesktopModel(workspace: string, home: string, input: AddDesktopModelInput): Promise<DesktopModelOption> {
  const provider: ProviderConfig = {
    type: input.protocol,
    baseURL: input.baseURL,
    apiKey: input.apiKey,
    defaultModel: input.model,
    models: [input.model],
  };
  await setGlobalProviderConfig(home, input.provider, provider);
  await setProjectProviderConfig(workspace, input.provider, provider);
  return {
    id: `${input.provider}:${input.model}`,
    provider: input.provider,
    model: input.model,
    label: input.model,
    description: `${input.provider} · ${protocolLabel(input.protocol)}`,
    source: "custom",
  };
}

function protocolLabel(type: string): string {
  return type === "anthropic" ? "Anthropic API" : "OpenAI 兼容 API";
}
