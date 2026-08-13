import { parseD2cJudgeModelResponse, type D2cJudgeConfig, type D2cJudgeModelAssessment } from "../d2c/judge.js";
import { parseD2cAutonomousPlanResponse, type D2cAutonomousInteractionPlan } from "../d2c/interaction-review.js";

export interface D2cJudgeClientInput {
  prompt: string;
  designPng: Buffer;
  implementationPng: Buffer;
}

export interface D2cJudgeClient {
  evaluate(config: D2cJudgeConfig, input: D2cJudgeClientInput): Promise<D2cJudgeModelAssessment>;
  planInteractions(config: D2cJudgeConfig, input: {
    prompt: string;
    screenshots: readonly Buffer[];
    observedPages: readonly string[];
    observedSelectors?: readonly string[];
  }): Promise<D2cAutonomousInteractionPlan>;
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

function causeDetail(value: unknown): string {
  if (!(value instanceof Error)) return String(value);
  const nested = value.cause;
  if (nested instanceof Error) return `${value.message}: ${nested.message}`;
  if (typeof nested === "object" && nested !== null) {
    const code = "code" in nested ? String(nested.code) : undefined;
    const message = "message" in nested ? String(nested.message) : undefined;
    if (code !== undefined || message !== undefined) return `${value.message}: ${[code, message].filter(Boolean).join(" ")}`;
  }
  return value.message;
}

function isAbort(value: unknown): boolean {
  return value instanceof Error && (value.name === "AbortError" || value.name === "TimeoutError");
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

export function createD2cJudgeClient(
  fetcher: Fetch = globalThis.fetch,
  retryDelay: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): D2cJudgeClient {
  const request = async (config: D2cJudgeConfig, prompt: string, images: readonly Buffer[], maxTokens: number): Promise<string> => {
    const openAi = config.protocol === "openai-compatible";
    const imageContent = openAi
      ? images.map((image) => ({ type: "image_url", image_url: { url: dataUrl(image), detail: "high" } }))
      : images.map((image) => ({ type: "image", source: { type: "base64", media_type: "image/png", data: image.toString("base64") } }));
    const body = openAi ? {
      model: config.model,
      max_tokens: maxTokens,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [{ role: "user", content: [{ type: "text", text: prompt }, ...imageContent] }],
    } : {
      model: config.model,
      max_tokens: maxTokens,
      temperature: 0,
      messages: [{ role: "user", content: [{ type: "text", text: prompt }, ...imageContent] }],
    };
    const target = endpoint(config.baseURL, config.protocol);
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      let response: Response;
      try {
        response = await fetcher(target, {
          method: "POST",
          headers: openAi
            ? { "content-type": "application/json", Authorization: `Bearer ${config.apiKey}` }
            : { "content-type": "application/json", "x-api-key": config.apiKey, "anthropic-version": "2023-06-01" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(180_000),
        });
      } catch (cause) {
        if (attempt === 1 && !isAbort(cause)) { await retryDelay(300); continue; }
        throw new Error(`D2C Judge network request failed at ${target}: ${redact(causeDetail(cause), config.apiKey)}`);
      }
      const raw = await response.text();
      let parsed: unknown;
      try { parsed = JSON.parse(raw); }
      catch { parsed = undefined; }
      if (!response.ok) {
        if (attempt === 1 && (response.status === 408 || response.status === 429 || response.status >= 500)) {
          await retryDelay(300); continue;
        }
        const detail = errorMessage(parsed);
        throw new Error(`D2C Judge request failed (${response.status})${detail === undefined ? "" : `: ${redact(detail, config.apiKey)}`}`);
      }
      return responseText(config.protocol, parsed);
    }
    throw new Error("D2C Judge request exhausted retries");
  };
  return {
    async evaluate(config, input) {
      return parseD2cJudgeModelResponse(await request(config, input.prompt, [input.designPng, input.implementationPng], 4_096));
    },
    async planInteractions(config, input) {
      const screenshots = input.screenshots.slice(0, 12);
      if (screenshots.length === 0) throw new Error("D2C autonomous reviewer requires at least one page screenshot");
      const raw = await request(config, input.prompt, screenshots, 16_384);
      return parseD2cAutonomousPlanResponse(raw, {
        model: config.model,
        observedPages: input.observedPages,
        ...(input.observedSelectors === undefined ? {} : { observedSelectors: input.observedSelectors }),
      });
    },
  };
}
