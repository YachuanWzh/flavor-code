import { parseD2cJudgeModelResponse, type D2cJudgeConfig, type D2cJudgeModelAssessment } from "../d2c/judge.js";

export interface D2cJudgeClientInput {
  prompt: string;
  designPng: Buffer;
  implementationPng: Buffer;
}

export interface D2cJudgeClient {
  evaluate(config: D2cJudgeConfig, input: D2cJudgeClientInput): Promise<D2cJudgeModelAssessment>;
}

type Fetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

function endpoint(baseURL: string, protocol: D2cJudgeConfig["protocol"]): string {
  const root = baseURL.replace(/\/+$/, "");
  if (protocol === "openai-compatible") return `${root}/chat/completions`;
  return `${root}${/\/v1$/i.test(root) ? "" : "/v1"}/messages`;
}

function dataUrl(buffer: Buffer): string {
  return `data:image/png;base64,${buffer.toString("base64")}`;
}

function errorMessage(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const error = "error" in value && typeof value.error === "object" && value.error !== null ? value.error as Record<string, unknown> : undefined;
  const message = error?.message ?? ("message" in value ? value.message : undefined);
  return typeof message === "string" ? message.slice(0, 1_000) : undefined;
}

function redact(value: string, apiKey: string): string {
  return value.replaceAll(apiKey, "[redacted]").replace(/(Bearer|x-api-key)\s+[^\s,;]+/gi, "$1 [redacted]");
}

function responseText(protocol: D2cJudgeConfig["protocol"], value: unknown): string {
  if (typeof value !== "object" || value === null) throw new Error("D2C Judge returned an invalid response");
  const record = value as Record<string, unknown>;
  if (protocol === "openai-compatible") {
    const choice = Array.isArray(record.choices) ? record.choices[0] as Record<string, unknown> | undefined : undefined;
    const message = choice?.message as Record<string, unknown> | undefined;
    if (typeof message?.content === "string") return message.content;
    if (Array.isArray(message?.content)) {
      return message.content.map((item) => typeof item === "object" && item !== null && "text" in item ? String(item.text) : "").join("");
    }
  } else if (Array.isArray(record.content)) {
    const text = record.content.map((item) => typeof item === "object" && item !== null && "text" in item ? String(item.text) : "").join("");
    if (text) return text;
  }
  throw new Error("D2C Judge response did not contain text output");
}

export function createD2cJudgeClient(fetcher: Fetch = globalThis.fetch): D2cJudgeClient {
  return {
    async evaluate(config, input) {
      const openAi = config.protocol === "openai-compatible";
      const body = openAi ? {
        model: config.model,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [{ role: "user", content: [
          { type: "text", text: input.prompt },
          { type: "image_url", image_url: { url: dataUrl(input.designPng), detail: "high" } },
          { type: "image_url", image_url: { url: dataUrl(input.implementationPng), detail: "high" } },
        ] }],
      } : {
        model: config.model,
        max_tokens: 4_096,
        temperature: 0,
        messages: [{ role: "user", content: [
          { type: "text", text: input.prompt },
          { type: "image", source: { type: "base64", media_type: "image/png", data: input.designPng.toString("base64") } },
          { type: "image", source: { type: "base64", media_type: "image/png", data: input.implementationPng.toString("base64") } },
        ] }],
      };
      const response = await fetcher(endpoint(config.baseURL, config.protocol), {
        method: "POST",
        headers: openAi
          ? { "content-type": "application/json", Authorization: `Bearer ${config.apiKey}` }
          : { "content-type": "application/json", "x-api-key": config.apiKey, "anthropic-version": "2023-06-01" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(120_000),
      });
      const raw = await response.text();
      let parsed: unknown;
      try { parsed = JSON.parse(raw); }
      catch { parsed = undefined; }
      if (!response.ok) {
        const detail = errorMessage(parsed);
        throw new Error(`D2C Judge request failed (${response.status})${detail === undefined ? "" : `: ${redact(detail, config.apiKey)}`}`);
      }
      return parseD2cJudgeModelResponse(responseText(config.protocol, parsed));
    },
  };
}
