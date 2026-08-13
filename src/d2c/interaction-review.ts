import { z } from "zod";

import { parseInteractionManifest, type D2cInteractionManifest } from "./interaction.js";

export interface D2cInteractiveElementObservation {
  selector: string;
  tag: string;
  role?: string;
  type?: string;
  label?: string;
  text?: string;
  value?: string;
  href?: string;
  visible: boolean;
  disabled: boolean;
}

export interface D2cPageObservation {
  url: string;
  title: string;
  viewport: { width: number; height: number };
  headings: string[];
  bodyText: string;
  elements: D2cInteractiveElementObservation[];
  screenshot: Buffer;
}

export interface D2cAutonomousInteractionPlan {
  schema: 1;
  model: string;
  plannedAt: string;
  summary: string;
  pageAnalyses: Array<{ url: string; pageType: string; goals: string[]; risks: string[] }>;
  manifest: D2cInteractionManifest;
}

const ModelPlanSchema = z.object({
  summary: z.string().trim().min(1).max(4_000),
  pageAnalyses: z.array(z.object({
    url: z.string().trim().min(1).max(1_024),
    pageType: z.string().trim().min(1).max(128),
    goals: z.array(z.string().trim().min(1).max(1_000)).min(1).max(20),
    risks: z.array(z.string().trim().min(1).max(1_000)).max(20),
  }).strict()).min(1).max(100),
  manifest: z.unknown(),
}).strict();

function unfence(raw: string): string {
  const bounded = raw.trim().slice(0, 512_000);
  return bounded.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)?.[1] ?? bounded;
}

function parseJsonObject(raw: string): unknown {
  const value = unfence(raw);
  try { return JSON.parse(value); }
  catch {
    const start = value.indexOf("{");
    const end = value.lastIndexOf("}");
    if (start < 0 || end <= start) throw new Error("D2C autonomous reviewer did not return a JSON object");
    try { return JSON.parse(value.slice(start, end + 1)); }
    catch { throw new Error("D2C autonomous reviewer returned invalid JSON"); }
  }
}

function normalizedPage(value: string): string {
  const url = new URL(value, "http://127.0.0.1/");
  return url.pathname.replace(/^\//, "") || "index.html";
}

/**
 * Extracts stable locator keys (`#id` and `[attr=value]`) from a selector.
 * Structural selectors (tag/class/nth) yield no keys, so they are skipped by
 * existence validation rather than rejected for being unverifiable.
 */
function selectorKeys(selector: string): string[] {
  const keys: string[] = [];
  for (const match of selector.matchAll(/#([\w-]+)/g)) keys.push(`#${match[1]}`);
  for (const match of selector.matchAll(/\[([\w-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s\]]+)))?\]/g)) {
    const value = match[2] ?? match[3] ?? match[4] ?? "";
    keys.push(`${match[1]}=${value}`);
  }
  return keys;
}

export function validateAutonomousInteractionManifest(
  manifest: D2cInteractionManifest,
  observedPages: readonly string[],
  observedSelectors?: readonly string[],
): D2cInteractionManifest {
  const allowed = new Set(observedPages.map(normalizedPage));
  const planned = new Set(manifest.pages.map((page) => normalizedPage(page.url)));
  for (const page of planned) {
    if (!allowed.has(page)) throw new Error(`Autonomous interaction plan escaped the observed page set: ${page}`);
  }
  for (const page of allowed) {
    if (!planned.has(page)) throw new Error(`Autonomous interaction plan omitted an observed page: ${page}`);
  }
  const knownKeys = new Set((observedSelectors ?? []).flatMap(selectorKeys));
  const unresolvedSelectors = new Set<string>();
  const ids = new Set<string>();
  let total = 0;
  for (const page of manifest.pages) {
    if (page.scenarios.length === 0) throw new Error(`Autonomous interaction plan has no user journey for ${page.url}`);
    for (const scenario of page.scenarios) {
      total += 1;
      if (ids.has(scenario.id)) throw new Error(`Autonomous interaction plan contains duplicate scenario id: ${scenario.id}`);
      ids.add(scenario.id);
      const actions = scenario.steps.filter((step) => "action" in step);
      const expectations = scenario.steps.filter((step) => "expect" in step);
      if (actions.length === 0 || expectations.length === 0 || !("expect" in scenario.steps.at(-1)!)) {
        throw new Error(`Autonomous journey ${scenario.id} must perform actions and finish with observable evidence`);
      }
      for (const step of scenario.steps) {
        if (!("selector" in step) || step.selector === undefined) continue;
        const keys = selectorKeys(step.selector);
        if (keys.length === 0 || keys.some((key) => knownKeys.has(key))) continue;
        unresolvedSelectors.add(step.selector);
      }
    }
  }
  if (knownKeys.size > 0 && unresolvedSelectors.size > 0) {
    const sample = [...unresolvedSelectors].slice(0, 5).join(", ");
    throw new Error(`Autonomous interaction plan references selectors absent from the observed DOM: ${sample}`);
  }
  if (total > 100) throw new Error("Autonomous interaction plan exceeds 100 user journeys");
  return manifest;
}

export function mergeInteractionManifests(
  seed: D2cInteractionManifest,
  autonomous: D2cInteractionManifest,
): D2cInteractionManifest {
  const autonomousPages = new Map(autonomous.pages.map((page) => [normalizedPage(page.url), page]));
  return parseInteractionManifest(JSON.stringify({
    schemaVersion: 1,
    product: seed.product,
    deterministic: true,
    pages: seed.pages.map((page) => {
      const planned = autonomousPages.get(normalizedPage(page.url));
      const ids = new Set(page.scenarios.map((scenario) => scenario.id));
      return {
        url: page.url,
        ...(page.requireApi === undefined ? {} : { requireApi: page.requireApi }),
        scenarios: [
          ...page.scenarios,
          ...(planned?.scenarios.filter((scenario) => !ids.has(scenario.id)) ?? []),
        ],
      };
    }),
  }));
}

export function parseD2cAutonomousPlanResponse(
  raw: string,
  input: { model: string; observedPages: readonly string[]; observedSelectors?: readonly string[]; now?: Date },
): D2cAutonomousInteractionPlan {
  const modelPlan = ModelPlanSchema.parse(parseJsonObject(raw));
  const manifest = validateAutonomousInteractionManifest(
    parseInteractionManifest(JSON.stringify(modelPlan.manifest)),
    input.observedPages,
    input.observedSelectors,
  );
  return {
    schema: 1,
    model: input.model,
    plannedAt: (input.now ?? new Date()).toISOString(),
    summary: modelPlan.summary,
    pageAnalyses: modelPlan.pageAnalyses,
    manifest,
  };
}

function compactObservation(page: D2cPageObservation): object {
  return {
    url: page.url,
    title: page.title,
    viewport: page.viewport,
    headings: page.headings,
    bodyText: page.bodyText.slice(0, 8_000),
    elements: page.elements.slice(0, 500),
  };
}

export function buildD2cAutonomousPlanPrompt(input: {
  task: string;
  seed: D2cInteractionManifest;
  observations: readonly D2cPageObservation[];
  prd?: string;
  apiContext?: string;
}): string {
  return [
    `你是 D2C 自主交互审阅 Agent。请为任务“${input.task}”分析页面并生成可执行的端到端用户旅程。`,
    "你会收到每个页面的当前截图（顺序与 observations 一致）、结构化可操作元素、已有设计行为契约、PRD 和 API 上下文。截图用于理解产品形态、层级和视觉状态；DOM 用于选择真实 selector；已有契约只作种子，不是覆盖上限。",
    "先判断每页真实形态和核心任务，再决定测试：可能是表单、查询列表、管理后台、大屏、向导、详情、编辑器或混合页面。不要套用固定页面模板，也不要臆造页面没有的能力。",
    "必须覆盖主成功路径、关键失败/校验路径、恢复路径，以及页面真实存在的深层交互。适用时实际打开一级/二级/三级菜单、弹窗、抽屉、下钻或详情；填写表单时完成字段输入与提交；查询时触发查询并测试重置和翻页；大屏测试筛选联动、时间范围、悬停详情、刷新和下钻。",
    "场景必须是有业务逻辑的完整用户旅程，不能只是把指针移动到控件。每个旅程至少包含一个 action 和一个 expect，最后一步必须是 expect。点击、输入或选择之后必须最终产生可观察的 DOM、value、URL、数据或 API 证据。",
    "仅使用 observations 或 seed 中存在的页面和 selector；允许使用 open/click/fill/select/hover/blur/key/wait 动作，以及 visible/hidden/not-exists/text/text-contains/attribute/class/count/value/url 断言。open 的 url 和 url 断言的 value 都是不以 / 开头的工作区相对路径。所有页面必须至少有一条旅程。",
    "requireApi 只在该旅程按产品逻辑应触发网络请求时设为 true；纯本地菜单展开、Tab 切换、必填校验可设为 false。不要用脆弱的 nth-child，优先 id、data-*、aria-* 和稳定 href。",
    `PRD：\n${(input.prd ?? "未提供；以页面和现有契约为准").slice(0, 20_000)}`,
    `API 上下文：\n${(input.apiContext ?? "未提供").slice(0, 16_000)}`,
    `已有行为契约：\n${JSON.stringify(input.seed).slice(0, 60_000)}`,
    `页面 observations：\n${JSON.stringify(input.observations.map(compactObservation)).slice(0, 120_000)}`,
    "只返回一个 JSON 对象，不要 Markdown。结构：",
    '{"summary":"规划摘要","pageAnalyses":[{"url":"index.html","pageType":"页面类型","goals":["用户目标"],"risks":["风险"]}],"manifest":{"schemaVersion":1,"product":"产品名","deterministic":true,"pages":[{"url":"index.html","requireApi":false,"scenarios":[{"id":"journey-id","requireApi":false,"steps":[{"action":"click","selector":"#open"},{"expect":"visible","selector":"#panel"}]}]}]}}',
  ].join("\n").slice(0, 240_000);
}
