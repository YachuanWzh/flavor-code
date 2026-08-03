import { createHash } from "node:crypto";
import type { OAuthLlmConfig } from "./types.js";

export function oauthCredentialId(tokenUrl: string, clientId: string): string {
  const digest = createHash("sha256").update(`${tokenUrl}\0${clientId}`, "utf8").digest("base64url");
  return `oauth:${digest}`;
}

export function parseOAuthLlmConfig(value: unknown): OAuthLlmConfig {
  if (!isRecord(value)) throw new Error("Token response llm_config must be an object");
  const providerId = stringField(value, "provider_id");
  if (!/^[A-Za-z0-9_-]+$/.test(providerId)) throw new Error("llm_config.provider_id is invalid");
  const serviceName = stringField(value, "service_name");
  const apiType = stringField(value, "api_type");
  if (apiType !== "openai" && apiType !== "anthropic") throw new Error("llm_config.api_type is invalid");
  const baseURL = stringField(value, "base_url");
  try {
    const url = new URL(baseURL);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("protocol");
  } catch {
    throw new Error("llm_config.base_url must use http or https");
  }
  const defaultModel = stringField(value, "default_model");
  const cheapModel = stringField(value, "cheap_model");
  const modelsRaw = value["models"];
  if (!Array.isArray(modelsRaw) || modelsRaw.length === 0 || modelsRaw.some((item) => typeof item !== "string" || !item)) {
    throw new Error("llm_config.models must be a non-empty string array");
  }
  const models = [...new Set(modelsRaw as string[])];
  if (!models.includes(defaultModel)) throw new Error("llm_config.default_model must be included in models");
  if (!models.includes(cheapModel)) throw new Error("llm_config.cheap_model must be included in models");
  const maxOutputTokens = value["max_output_tokens"];
  if (maxOutputTokens !== undefined && (!Number.isInteger(maxOutputTokens) || (maxOutputTokens as number) <= 0)) {
    throw new Error("llm_config.max_output_tokens must be a positive integer");
  }
  return {
    providerId, serviceName, apiType, baseURL, defaultModel, cheapModel, models,
    ...(maxOutputTokens === undefined ? {} : { maxOutputTokens: maxOutputTokens as number }),
  };
}

export function isOAuthLlmConfig(value: unknown): value is OAuthLlmConfig {
  if (!isRecord(value)) return false;
  try {
    const wire = {
      provider_id: value["providerId"], service_name: value["serviceName"],
      api_type: value["apiType"], base_url: value["baseURL"],
      default_model: value["defaultModel"], cheap_model: value["cheapModel"],
      models: value["models"], max_output_tokens: value["maxOutputTokens"],
    };
    parseOAuthLlmConfig(wire);
    return true;
  } catch { return false; }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(value: Record<string, unknown>, key: string): string {
  const field = value[key];
  if (typeof field !== "string" || !field.trim()) throw new Error(`llm_config.${key} must be a non-empty string`);
  return field.trim();
}
