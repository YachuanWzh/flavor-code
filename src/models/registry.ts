import type { ModelAdapter } from "./types.js";

export interface ParsedModelId {
  provider: string;
  model: string;
}

export function parseModelId(id: string): ParsedModelId {
  const separator = id.indexOf(":");
  if (separator <= 0 || separator === id.length - 1) {
    throw new Error(`Invalid model id "${id}"; expected provider:model`);
  }

  return { provider: id.slice(0, separator), model: id.slice(separator + 1) };
}

export class ModelRegistry {
  private readonly adapters = new Map<string, ModelAdapter>();

  register(provider: string, adapter: ModelAdapter): this {
    if (!provider) throw new Error("Provider name must not be empty");
    this.adapters.set(provider, adapter);
    return this;
  }

  get(id: string): { adapter: ModelAdapter; model: string } {
    const { provider, model } = parseModelId(id);
    const adapter = this.adapters.get(provider);
    if (!adapter) throw new Error(`No model adapter registered for provider "${provider}"`);
    return { adapter, model };
  }
}
