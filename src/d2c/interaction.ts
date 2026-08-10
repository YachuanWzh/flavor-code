import { z } from "zod";

const SafePageUrl = z.string().trim().min(1).max(1_024).refine((value) => {
  if (value.includes("\\") || value.includes("\0") || value.includes("://") || value.startsWith("/") || value.startsWith("#")) return false;
  return !value.split("/").includes("..");
}, "Interaction page URL must be workspace-relative");

const ClickStep = z.object({ action: z.literal("click"), selector: z.string().min(1).max(2_048) }).strict();
const FillStep = z.object({ action: z.literal("fill"), selector: z.string().min(1).max(2_048), value: z.string().max(10_000) }).strict();
const HoverStep = z.object({ action: z.literal("hover"), selector: z.string().min(1).max(2_048) }).strict();
const KeyStep = z.object({ action: z.literal("key"), value: z.string().min(1).max(64) }).strict();
const VisibleStep = z.object({ expect: z.literal("visible"), selector: z.string().min(1).max(2_048) }).strict();
const TextStep = z.object({ expect: z.enum(["text", "text-contains"]), selector: z.string().min(1).max(2_048), value: z.string().max(10_000) }).strict();
const AttributeStep = z.object({ expect: z.literal("attribute"), selector: z.string().min(1).max(2_048), name: z.string().min(1).max(256), value: z.string().max(10_000) }).strict();
const ClassStep = z.object({ expect: z.literal("class"), selector: z.string().min(1).max(2_048), value: z.string().min(1).max(256) }).strict();
const CountStep = z.object({ expect: z.literal("count"), selector: z.string().min(1).max(2_048), value: z.number().int().nonnegative().max(100_000) }).strict();

const ActionStepSchema = z.union([ClickStep, FillStep, HoverStep, KeyStep]);
const ExpectStepSchema = z.union([VisibleStep, TextStep, AttributeStep, ClassStep, CountStep]);
const StepSchema = z.union([ActionStepSchema, ExpectStepSchema]);
const ScenarioSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
  requireApi: z.boolean().optional(),
  steps: z.array(StepSchema).min(1).max(500),
}).strict();
const ManifestSchema = z.object({
  schemaVersion: z.literal(1), product: z.string().trim().min(1).max(500), deterministic: z.literal(true),
  pages: z.array(z.object({ url: SafePageUrl, requireApi: z.boolean().optional(), scenarios: z.array(ScenarioSchema).max(500) }).strict()).min(1).max(100),
}).strict();

export type D2cInteractionActionStep = z.infer<typeof ActionStepSchema>;
export type D2cInteractionExpectStep = z.infer<typeof ExpectStepSchema>;
export type D2cInteractionManifest = z.infer<typeof ManifestSchema>;

export interface D2cInteractionDriver {
  load(url: string): Promise<void>;
  action(step: D2cInteractionActionStep): Promise<void>;
  assertion(step: D2cInteractionExpectStep): Promise<{ passed: boolean; actual?: string }>;
  settle?(): Promise<void>;
  apiRequestCount(): number;
  close(): Promise<void>;
}

export interface D2cInteractionScenarioResult {
  id: string;
  pageUrl: string;
  passed: boolean;
  durationMs: number;
  apiRequestCount: number;
  failure?: string;
}

export interface D2cInteractionRun {
  schema: 1;
  runAt: string;
  baseUrl: string;
  passed: boolean;
  total: number;
  failures: number;
  apiRequestCount: number;
  scenarios: D2cInteractionScenarioResult[];
}

export type D2cInteractionDriverFactory = (scenario: { id: string; pageUrl: string }) => Promise<D2cInteractionDriver>;

export function parseInteractionManifest(json: string): D2cInteractionManifest {
  if (Buffer.byteLength(json, "utf8") > 2 * 1024 * 1024) throw new Error("D2C interaction manifest exceeds 2 MiB");
  let parsed: unknown;
  try { parsed = JSON.parse(json); }
  catch { throw new Error("D2C interaction manifest is not valid JSON"); }
  return ManifestSchema.parse(parsed);
}

export function isLoopbackPreviewUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost") && url.username === "" && url.password === "";
  } catch { return false; }
}

function expectationDescription(step: D2cInteractionExpectStep): string {
  if (step.expect === "visible") return `${step.selector} to be visible`;
  if (step.expect === "attribute") return `${step.selector} attribute ${step.name} to equal ${step.value}`;
  if (step.expect === "class") return `${step.selector} to have class ${step.value}`;
  return `${step.selector} ${step.expect} to equal ${String(step.value)}`;
}

export async function runInteractionManifest(
  manifest: D2cInteractionManifest,
  baseUrl: string,
  createDriver: D2cInteractionDriverFactory,
): Promise<D2cInteractionRun> {
  if (!isLoopbackPreviewUrl(baseUrl)) throw new Error("D2C interaction preview must use a loopback HTTP URL");
  const origin = new URL(baseUrl).origin;
  const scenarios: D2cInteractionScenarioResult[] = [];
  for (const page of manifest.pages) {
    const pageUrl = new URL(page.url, baseUrl).toString();
    if (new URL(pageUrl).origin !== origin) throw new Error(`D2C interaction page escaped preview origin: ${page.url}`);
    for (const scenario of page.scenarios) {
      const started = Date.now();
      let driver: D2cInteractionDriver | undefined;
      let failure: string | undefined;
      let apiRequestCount = 0;
      try {
        driver = await createDriver({ id: scenario.id, pageUrl });
        await driver.load(pageUrl);
        for (const step of scenario.steps) {
          if ("action" in step) await driver.action(step);
          else {
            const result = await driver.assertion(step);
            if (!result.passed) throw new Error(`Expected ${expectationDescription(step)}; actual ${result.actual ?? "unknown"}`);
          }
        }
        await driver.settle?.();
        apiRequestCount = driver.apiRequestCount();
        if ((scenario.requireApi ?? page.requireApi ?? true) && apiRequestCount === 0) {
          throw new Error("No API request was observed; the page is still behaving as a static implementation");
        }
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error);
        apiRequestCount = driver?.apiRequestCount() ?? 0;
      } finally {
        await driver?.close().catch(() => undefined);
      }
      scenarios.push({ id: scenario.id, pageUrl, passed: failure === undefined, durationMs: Date.now() - started, apiRequestCount,
        ...(failure === undefined ? {} : { failure }) });
    }
  }
  const failures = scenarios.filter((item) => !item.passed).length;
  return { schema: 1, runAt: new Date().toISOString(), baseUrl, passed: failures === 0, total: scenarios.length, failures,
    apiRequestCount: scenarios.reduce((total, item) => total + item.apiRequestCount, 0), scenarios };
}
