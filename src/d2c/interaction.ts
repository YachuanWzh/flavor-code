import { z } from "zod";

const SafePageUrl = z.string().trim().min(1).max(1_024).refine((value) => {
  if (value.includes("\\") || value.includes("\0") || value.includes("://") || value.startsWith("/") || value.startsWith("#")) return false;
  return !value.split("/").includes("..");
}, "Interaction page URL must be workspace-relative");

const ClickStep = z.object({ action: z.literal("click"), selector: z.string().min(1).max(2_048) }).strict();
const FillStep = z.object({ action: z.literal("fill"), selector: z.string().min(1).max(2_048), value: z.string().max(10_000) }).strict();
const SelectStep = z.object({ action: z.literal("select"), selector: z.string().min(1).max(2_048), value: z.string().max(10_000) }).strict();
const HoverStep = z.object({ action: z.literal("hover"), selector: z.string().min(1).max(2_048) }).strict();
const BlurStep = z.object({ action: z.literal("blur"), selector: z.string().min(1).max(2_048) }).strict();
const KeyStep = z.object({ action: z.literal("key"), value: z.string().min(1).max(64) }).strict();
const WaitStep = z.object({ action: z.literal("wait"), ms: z.number().int().nonnegative().max(30_000) }).strict();
const OpenStep = z.object({ action: z.literal("open"), url: SafePageUrl }).strict();
const VisibleStep = z.object({ expect: z.literal("visible"), selector: z.string().min(1).max(2_048) }).strict();
const HiddenStep = z.object({ expect: z.literal("hidden"), selector: z.string().min(1).max(2_048) }).strict();
const NotExistsStep = z.object({ expect: z.literal("not-exists"), selector: z.string().min(1).max(2_048) }).strict();
const TextStep = z.object({ expect: z.enum(["text", "text-contains"]), selector: z.string().min(1).max(2_048), value: z.string().max(10_000) }).strict();
const AttributeStep = z.object({ expect: z.literal("attribute"), selector: z.string().min(1).max(2_048), name: z.string().min(1).max(256), value: z.string().max(10_000) }).strict();
const ClassStep = z.object({ expect: z.literal("class"), selector: z.string().min(1).max(2_048), value: z.string().min(1).max(256) }).strict();
const CountStep = z.object({ expect: z.literal("count"), selector: z.string().min(1).max(2_048), value: z.number().int().nonnegative().max(100_000) }).strict();
const ValueStep = z.object({ expect: z.literal("value"), selector: z.string().min(1).max(2_048), value: z.string().max(10_000) }).strict();
const UrlStep = z.object({ expect: z.literal("url"), value: SafePageUrl }).strict();

const ActionStepSchema = z.union([ClickStep, FillStep, SelectStep, HoverStep, BlurStep, KeyStep, WaitStep, OpenStep]);
const ExpectStepSchema = z.union([VisibleStep, HiddenStep, NotExistsStep, TextStep, AttributeStep, ClassStep, CountStep, ValueStep, UrlStep]);
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeRequireApi(value: unknown): unknown {
  return Array.isArray(value) ? value.length > 0 : value;
}

const MODEL_EXPECTATION_ACTIONS = new Set([
  "visible", "hidden", "not-exists", "text", "text-contains", "attribute", "class", "count", "value", "url",
]);

function normalizeInteractionStep(stepValue: unknown, pageUrl: unknown): unknown {
  if (!isRecord(stepValue)) return stepValue;
  const step = { ...stepValue };
  if (typeof step.action === "string" && MODEL_EXPECTATION_ACTIONS.has(step.action)) {
    step.expect = step.action;
    delete step.action;
  }
  if (step.action === "expect" && typeof step.type === "string") {
    step.expect = step.type;
    delete step.action;
    delete step.type;
  }
  if (step.expect === "attribute" && typeof step.attribute === "string" && step.name === undefined) {
    step.name = step.attribute;
    delete step.attribute;
  }
  if (step.expect === "url") {
    delete step.selector;
    if (typeof step.value === "string" && step.value.startsWith("#") && typeof pageUrl === "string") {
      const pageEntry = pageUrl.split("#", 1)[0];
      if (pageEntry !== undefined && pageEntry.length > 0) step.value = `${pageEntry}${step.value}`;
    }
  }
  return step;
}

function normalizeInteractionManifest(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const manifest = { ...value };
  delete manifest.notes;
  if (!Array.isArray(manifest.pages)) return manifest;
  manifest.pages = manifest.pages.map((pageValue) => {
    if (!isRecord(pageValue)) return pageValue;
    const page = { ...pageValue };
    delete page.title;
    if ("requireApi" in page) page.requireApi = normalizeRequireApi(page.requireApi);
    if (!Array.isArray(page.scenarios)) return page;
    page.scenarios = page.scenarios.map((scenarioValue) => {
      if (!isRecord(scenarioValue)) return scenarioValue;
      const scenario = { ...scenarioValue };
      delete scenario.title;
      if ("requireApi" in scenario) scenario.requireApi = normalizeRequireApi(scenario.requireApi);
      if (!Array.isArray(scenario.steps)) return scenario;
      scenario.steps = scenario.steps.map((stepValue) => normalizeInteractionStep(stepValue, page.url));
      return scenario;
    });
    return page;
  });
  return manifest;
}

function manifestIssueSummary(error: z.ZodError): string {
  return error.issues.slice(0, 8).map((issue) => {
    const path = issue.path.length === 0 ? "manifest" : issue.path.join(".");
    return `${path}: ${issue.message}`;
  }).join("; ");
}

export interface D2cInteractionDriver {
  load(url: string): Promise<void>;
  action(step: D2cInteractionActionStep): Promise<void>;
  assertion(step: D2cInteractionExpectStep): Promise<{ passed: boolean; actual?: string }>;
  settle?(): Promise<void>;
  /** Optional host-side diagnostics (network/console errors) surfaced alongside a failure. */
  diagnostics?(): string | undefined;
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
  const result = ManifestSchema.safeParse(normalizeInteractionManifest(parsed));
  if (!result.success) throw new Error(`Invalid D2C interaction manifest: ${manifestIssueSummary(result.error)}`);
  return result.data;
}

export function isLoopbackPreviewUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost") && url.username === "" && url.password === "";
  } catch { return false; }
}

function expectationDescription(step: D2cInteractionExpectStep): string {
  if (step.expect === "url") return `URL path to equal ${step.value}`;
  if (step.expect === "visible") return `${step.selector} to be visible`;
  if (step.expect === "hidden") return `${step.selector} to be hidden`;
  if (step.expect === "not-exists") return `${step.selector} not to exist`;
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
        const diagnostics = driver?.diagnostics?.();
        if (diagnostics !== undefined) failure = `${failure} | ${diagnostics}`;
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
