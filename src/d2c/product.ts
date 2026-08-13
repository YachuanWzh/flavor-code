import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import { D2C_TASK_PATTERN, taskDir } from "./store.js";
import { parseInteractionManifest, interactionManifestSchemaGuide } from "./interaction.js";
import type { D2cModuleDefinition } from "./openapi.js";

export type D2cProductPhase = "prd-generating" | "prd-review" | "design-generating" | "design-review" | "ready-for-d2c";
export type D2cProductStage = "prd" | "design";

export interface D2cProductTechnology {
  frontend: string;
  backend: string;
  frontendSource: "default" | "requirement";
  backendSource: "default" | "requirement";
}

export interface D2cProductPlan {
  schema: 1;
  task: string;
  revision: number;
  phase: D2cProductPhase;
  framework: "vue" | "react";
  technology?: D2cProductTechnology;
  requirement: string;
  prd?: { path: "product/prd.md"; updatedAt: string; contentHash?: string };
  prototype?: {
    entryHtml: "product/prototype/index.html";
    interactionManifest: "product/prototype/interaction-manifest.json";
    updatedAt: string;
    contentHash?: string;
  };
  feedback?: { stage: D2cProductStage; message: string; updatedAt: string };
  createdAt: string;
  updatedAt: string;
}

export interface D2cProductPlanView {
  plan: D2cProductPlan;
  prdMarkdown?: string;
  validationError?: { stage: "design"; message: string };
}

export interface CreateD2cProductPlanInput {
  task: string;
  framework: "vue" | "react";
  requirement: string;
}

const RelativePrdPath = "product/prd.md" as const;
const RelativePrototypePath = "product/prototype/index.html" as const;
const RelativeInteractionPath = "product/prototype/interaction-manifest.json" as const;

export interface D2cProductPlanFileOperations {
  rename(source: string, target: string): Promise<void>;
  copyFile(source: string, target: string): Promise<void>;
  unlink(path: string): Promise<void>;
}

const defaultPlanFileOperations: D2cProductPlanFileOperations = { rename, copyFile, unlink };
const planWriteQueues = new Map<string, Promise<void>>();

const PlanSchema = z.object({
  schema: z.literal(1),
  task: z.string().regex(D2C_TASK_PATTERN),
  revision: z.number().int().nonnegative(),
  phase: z.enum(["prd-generating", "prd-review", "design-generating", "design-review", "ready-for-d2c"]),
  framework: z.enum(["vue", "react"]),
  technology: z.object({
    frontend: z.string().trim().min(1).max(64),
    backend: z.string().trim().min(1).max(64),
    frontendSource: z.enum(["default", "requirement"]),
    backendSource: z.enum(["default", "requirement"]),
  }).strict().optional(),
  requirement: z.string().trim().min(2).max(50_000),
  prd: z.object({ path: z.literal(RelativePrdPath), updatedAt: z.iso.datetime(), contentHash: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict().optional(),
  prototype: z.object({
    entryHtml: z.literal(RelativePrototypePath),
    interactionManifest: z.literal(RelativeInteractionPath),
    updatedAt: z.iso.datetime(),
    contentHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  }).strict().optional(),
  feedback: z.object({
    stage: z.enum(["prd", "design"]), message: z.string().trim().min(1).max(10_000), updatedAt: z.iso.datetime(),
  }).strict().optional(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
}).strict();

export function d2cProductDirectory(workspace: string, task: string): string {
  if (!D2C_TASK_PATTERN.test(task)) throw new Error("Invalid D2C task name");
  return join(taskDir(workspace, task), "product");
}

export function d2cProductPrototypeDirectory(workspace: string, task: string): string {
  return join(d2cProductDirectory(workspace, task), "prototype");
}

function planPath(workspace: string, task: string): string {
  return join(taskDir(workspace, task), "product-plan.json");
}

export function resolveD2cProductTechnology(
  requirement: string,
  fallbackFramework: "vue" | "react" = "vue",
): D2cProductTechnology & { framework: "vue" | "react" } {
  const frontendCandidates: Array<{ pattern: RegExp; frontend: string; framework?: "vue" | "react" }> = [
    { pattern: /\bnext(?:\.?js)?\b/i, frontend: "Next.js", framework: "react" },
    { pattern: /\breact(?:\.?js)?\b/i, frontend: "React", framework: "react" },
    { pattern: /\bnuxt(?:\.?js)?\b/i, frontend: "Nuxt", framework: "vue" },
    { pattern: /\bvue(?:\.?js)?\b/i, frontend: "Vue 3", framework: "vue" },
    { pattern: /\bangular\b/i, frontend: "Angular" },
    { pattern: /\bsvelte(?:kit)?\b/i, frontend: "Svelte" },
    { pattern: /原生\s*(?:html|javascript|js)|\bvanilla\s+(?:javascript|js|typescript|ts)\b/i, frontend: "Vanilla TypeScript" },
  ];
  const backendCandidates: Array<{ pattern: RegExp; backend: string }> = [
    { pattern: /\bfastapi\b/i, backend: "Python / FastAPI" },
    { pattern: /\bdjango\b/i, backend: "Python / Django" },
    { pattern: /\bflask\b/i, backend: "Python / Flask" },
    { pattern: /\bpython\b|服务端.{0,8}python|后端.{0,8}python/i, backend: "Python" },
    { pattern: /\bnest(?:\.?js)?\b/i, backend: "Node.js / NestJS" },
    { pattern: /\bexpress(?:\.?js)?\b/i, backend: "Node.js / Express" },
    { pattern: /\bnode(?:\.?js)?\b/i, backend: "Node.js" },
    { pattern: /\bspring(?:\s*boot)?\b/i, backend: "Java / Spring Boot" },
    { pattern: /\bjava\b/i, backend: "Java" },
    { pattern: /\bgolang\b|\bgo\s+(?:语言|后端|服务)/i, backend: "Go" },
    { pattern: /\basp\.?net\b|\b\.net\b|\bc#\b/i, backend: ".NET" },
    { pattern: /\blaravel\b/i, backend: "PHP / Laravel" },
    { pattern: /\bphp\b/i, backend: "PHP" },
    { pattern: /\bruby\s+on\s+rails\b|\brails\b/i, backend: "Ruby on Rails" },
    { pattern: /\brust\b/i, backend: "Rust" },
  ];
  const requestedFrontend = frontendCandidates.find(({ pattern }) => pattern.test(requirement));
  const requestedBackend = backendCandidates.find(({ pattern }) => pattern.test(requirement));
  return {
    framework: requestedFrontend?.framework ?? fallbackFramework,
    frontend: requestedFrontend?.frontend ?? (fallbackFramework === "vue" ? "Vue 3" : "React"),
    backend: requestedBackend?.backend ?? "Python",
    frontendSource: requestedFrontend === undefined ? "default" : "requirement",
    backendSource: requestedBackend === undefined ? "default" : "requirement",
  };
}

function productTechnology(plan: D2cProductPlan): D2cProductTechnology {
  return plan.technology ?? {
    frontend: plan.framework === "vue" ? "Vue 3" : "React",
    backend: "Python",
    frontendSource: "default",
    backendSource: "default",
  };
}

function operationSuffix(value: string): string {
  const words = value.split(/[^A-Za-z0-9]+/).filter(Boolean);
  const suffix = words.map((word) => word[0]!.toUpperCase() + word.slice(1)).join("");
  return suffix || "Module";
}

export function buildD2cProductOpenApi(task: string, modules: readonly D2cModuleDefinition[]): string {
  const paths = Object.fromEntries(modules.map((module) => {
    const safeId = module.id.replace(/[^A-Za-z0-9._-]/g, "-");
    const suffix = operationSuffix(module.id);
    const tags = [module.id, ...(module.keywords ?? [])].slice(0, 20);
    return [`/api/${safeId}`, {
      get: {
        operationId: `get${suffix}`,
        summary: `读取${module.label}`,
        tags,
        responses: { "200": { description: "成功", content: { "application/json": { schema: {
          type: "object", properties: { success: { type: "boolean", example: true }, data: { type: "object", additionalProperties: true } },
        } } } } },
      },
      post: {
        operationId: `update${suffix}`,
        summary: `执行${module.label}操作`,
        tags,
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", additionalProperties: true } } } },
        responses: { "200": { description: "成功", content: { "application/json": { schema: {
          type: "object", properties: { success: { type: "boolean", example: true }, data: { type: "object", additionalProperties: true } },
        } } } } },
      },
    }];
  }));
  return `${JSON.stringify({
    openapi: "3.1.0",
    info: { title: `${task} API`, version: "1.0.0", description: "由 E2E 根据已确认 PRD 与实现模块自动生成的服务契约" },
    servers: [{ url: "/" }],
    paths,
  }, null, 2)}\n`;
}

async function fileTimestamp(path: string): Promise<string | undefined> {
  const info = await stat(path).catch(() => undefined);
  return info?.isFile() ? info.mtime.toISOString() : undefined;
}

async function fileHash(path: string): Promise<string | undefined> {
  const buffer = await readFile(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  return buffer === undefined ? undefined : createHash("sha256").update(buffer).digest("hex");
}

async function validateAndNormalizePrototypeManifest(path: string): Promise<string | undefined> {
  const raw = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (raw === undefined) return undefined;
  try {
    const manifest = parseInteractionManifest(raw);
    const canonical = `${JSON.stringify(manifest, null, 2)}\n`;
    if (raw !== canonical) await writeFile(path, canonical, { encoding: "utf8", mode: 0o600 });
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function canFallbackFromPlanRename(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "EPERM" || code === "EACCES" || code === "EBUSY" || code === "EEXIST";
}

async function replaceD2cProductPlanFile(
  temporary: string,
  target: string,
  operations: D2cProductPlanFileOperations,
): Promise<void> {
  try {
    await operations.rename(temporary, target);
  } catch (error) {
    if (!canFallbackFromPlanRename(error)) throw error;
    // Windows may refuse rename-over-existing while Explorer, antivirus, or another poll still has the file open.
    // copyFile replaces the small JSON file in place and keeps the previous file intact if the copy itself fails.
    await operations.copyFile(temporary, target);
    await operations.unlink(temporary).catch(() => undefined);
  }
}

async function serializePlanWrite(target: string, operation: () => Promise<void>): Promise<void> {
  const previous = planWriteQueues.get(target) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  const settled = current.then(() => undefined, () => undefined);
  planWriteQueues.set(target, settled);
  try {
    await current;
  } finally {
    if (planWriteQueues.get(target) === settled) planWriteQueues.delete(target);
  }
}

export async function writeD2cProductPlan(
  workspace: string,
  plan: D2cProductPlan,
  operations: D2cProductPlanFileOperations = defaultPlanFileOperations,
): Promise<D2cProductPlan> {
  const parsed = PlanSchema.parse(plan) as D2cProductPlan;
  const target = planPath(workspace, parsed.task);
  await serializePlanWrite(target, async () => {
    await mkdir(taskDir(workspace, parsed.task), { recursive: true });
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(parsed, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await replaceD2cProductPlanFile(temporary, target, operations);
  });
  return parsed;
}

export async function createD2cProductPlan(
  workspace: string,
  input: CreateD2cProductPlanInput,
  now: () => Date = () => new Date(),
): Promise<D2cProductPlan> {
  const parsed = z.object({
    task: z.string().regex(D2C_TASK_PATTERN), framework: z.enum(["vue", "react"]),
    requirement: z.string().trim().min(2).max(50_000),
  }).strict().parse(input);
  const timestamp = now().toISOString();
  if (await readD2cProductPlan(workspace, parsed.task) !== undefined) {
    throw new Error(`D2C product plan already exists: ${parsed.task}`);
  }
  const { framework, ...technology } = resolveD2cProductTechnology(parsed.requirement, parsed.framework);
  await mkdir(d2cProductPrototypeDirectory(workspace, parsed.task), { recursive: true });
  return writeD2cProductPlan(workspace, {
    schema: 1, task: parsed.task, revision: 0, phase: "prd-generating", framework, technology,
    requirement: parsed.requirement, createdAt: timestamp, updatedAt: timestamp,
  });
}

export async function readD2cProductPlan(workspace: string, task: string): Promise<D2cProductPlan | undefined> {
  const raw = await readFile(planPath(workspace, task), "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  return raw === undefined ? undefined : PlanSchema.parse(JSON.parse(raw)) as D2cProductPlan;
}

export async function discoverD2cProductArtifacts(workspace: string, plan: D2cProductPlan): Promise<D2cProductPlan> {
  const product = d2cProductDirectory(workspace, plan.task);
  const prdUpdatedAt = await fileTimestamp(join(product, "prd.md"));
  const prdHash = await fileHash(join(product, "prd.md"));
  const prototypeUpdatedAt = await fileTimestamp(join(product, "prototype", "index.html"));
  const prototypeHash = await fileHash(join(product, "prototype", "index.html"));
  const expectedManifest = join(product, "prototype", "interaction-manifest.json");
  let manifestUpdatedAt = await fileTimestamp(expectedManifest);
  if (manifestUpdatedAt === undefined) {
    const misplacedManifest = join(product, "interaction-manifest.json");
    if (await fileTimestamp(misplacedManifest) !== undefined) {
      await mkdir(join(product, "prototype"), { recursive: true });
      await copyFile(misplacedManifest, expectedManifest);
      manifestUpdatedAt = await fileTimestamp(expectedManifest);
    }
  }
  const manifestError = manifestUpdatedAt === undefined
    ? undefined
    : await validateAndNormalizePrototypeManifest(expectedManifest);
  const prototypeComplete = prototypeUpdatedAt !== undefined && manifestUpdatedAt !== undefined && manifestError === undefined;
  let phase = plan.phase;
  if (prdHash !== undefined && phase === "prd-generating" && prdHash !== plan.prd?.contentHash) phase = "prd-review";
  if (prototypeComplete && phase === "design-generating"
    && (prototypeHash !== plan.prototype?.contentHash || plan.prototype?.interactionManifest === undefined)) phase = "design-review";
  if (!prototypeComplete && manifestUpdatedAt !== undefined && phase === "design-review") phase = "design-generating";
  const changed = phase !== plan.phase
    || (prdHash !== undefined && prdHash !== plan.prd?.contentHash)
    || (prototypeComplete && prototypeHash !== plan.prototype?.contentHash)
    || (prototypeComplete && plan.prototype?.interactionManifest === undefined);
  if (!changed) return plan;
  const now = new Date().toISOString();
  return {
    ...plan, revision: plan.revision + 1, phase,
    ...(prdHash === undefined ? {} : { prd: { path: RelativePrdPath, updatedAt: prdUpdatedAt!, contentHash: prdHash } }),
    ...(!prototypeComplete ? {} : { prototype: {
      entryHtml: RelativePrototypePath,
      interactionManifest: RelativeInteractionPath,
      updatedAt: prototypeUpdatedAt!,
      contentHash: prototypeHash!,
    } }),
    updatedAt: now,
  };
}

export async function readD2cProductPlanView(workspace: string, task: string): Promise<D2cProductPlanView | undefined> {
  const stored = await readD2cProductPlan(workspace, task);
  if (stored === undefined) return undefined;
  const plan = await discoverD2cProductArtifacts(workspace, stored);
  if (plan.revision !== stored.revision) await writeD2cProductPlan(workspace, plan);
  const prdMarkdown = plan.prd === undefined
    ? undefined
    : await readFile(join(taskDir(workspace, task), plan.prd.path), "utf8");
  const manifestPath = join(d2cProductDirectory(workspace, task), "prototype", "interaction-manifest.json");
  const validationError = plan.phase === "design-generating" && await fileTimestamp(manifestPath) !== undefined
    ? await validateAndNormalizePrototypeManifest(manifestPath)
    : undefined;
  return {
    plan,
    ...(prdMarkdown === undefined ? {} : { prdMarkdown }),
    ...(validationError === undefined ? {} : { validationError: { stage: "design" as const, message: validationError } }),
  };
}

export function applyD2cProductDecision(
  plan: D2cProductPlan,
  stage: D2cProductStage,
  accepted: boolean,
  feedback?: string,
  timestamp = new Date().toISOString(),
): D2cProductPlan {
  if (stage === "prd" && plan.phase !== "prd-review") throw new Error("D2C product plan is not in PRD review");
  if (stage === "design" && plan.phase !== "design-review") throw new Error("D2C product plan is not in design review");
  if (!accepted && (feedback === undefined || feedback.trim().length === 0)) throw new Error("Feedback is required when rejecting a D2C artifact");
  const { feedback: _previousFeedback, ...base } = plan;
  return {
    ...base, revision: plan.revision + 1,
    phase: stage === "prd" ? accepted ? "design-generating" : "prd-generating" : accepted ? "ready-for-d2c" : "design-generating",
    ...(!accepted && feedback !== undefined ? { feedback: { stage, message: feedback.trim(), updatedAt: timestamp } } : {}),
    updatedAt: timestamp,
  };
}

export function buildD2cPrdPrompt(plan: D2cProductPlan): string {
  const feedback = plan.feedback?.stage === "prd" ? `\n本轮必须处理用户反馈：${plan.feedback.message}` : "";
  const technology = productTechnology(plan);
  return [
    `为 D2C 任务“${plan.task}”生成可评审 PRD。原始需求：${plan.requirement}${feedback}`,
    `本任务技术方案：前端 ${technology.frontend}，服务端 ${technology.backend}。未在需求中明确的技术栈使用默认值；需求中明确指定的技术栈优先，不得被默认值覆盖。`,
    "需求未指定数据库时，开发与联调默认使用 SQLite；服务端必须通过可迁移的数据访问层和 DATABASE_URL 配置连接，避免 SQLite 专属业务 SQL，保证后续可平滑迁移到 MySQL 或 PostgreSQL。",
    `只创建或修改 .flavor/d2c/${plan.task}/product/prd.md；此阶段不要编写产品代码或设计原型。`,
    "先检查工作区现有产品语境、设计系统和相关代码；只有会实质改变产品范围的问题才使用 AskUserQuestion。",
    "PRD 必须包含：背景与目标、目标用户与核心问题、范围与非范围、用户故事、信息架构/页面清单、关键流程、loading/empty/error/success 状态、交互规则、数据与 API 假设、可逐条验证的验收标准、风险和未决问题。",
    "明确区分事实、合理假设和待确认项；不要伪造指标、接口或业务规则。完成文件后汇报路径和最需要用户确认的三项决策。",
  ].join("\n");
}

export function buildD2cDesignPrompt(plan: D2cProductPlan, prdMarkdown: string): string {
  const artifactPaths = `交互清单必须写入 .flavor/d2c/${plan.task}/product/prototype/interaction-manifest.json；不要写到 product 目录根部。`;
  if (plan.phase !== "design-generating") throw new Error("Approve the PRD before generating the design");
  const feedback = plan.feedback?.stage === "design" ? `\n本轮必须处理用户反馈：${plan.feedback.message}` : "";
  const technology = productTechnology(plan);
  return [
    artifactPaths,
    `根据已确认 PRD 为 D2C 任务“${plan.task}”生成视觉与交互原型。${feedback}`,
    `PRD 位于 .flavor/d2c/${plan.task}/product/prd.md，并以其中内容为唯一产品范围。`,
    `创建 .flavor/d2c/${plan.task}/product/prototype/index.html、必要的本地 assets、interaction-manifest.json，以及 .flavor/d2c/${plan.task}/product/openapi.json。openapi.json 必须是与已确认 PRD 一致的 OpenAPI 3.1 契约，供后续 Python 服务端与前端联调自动使用。`,
    "后续验收将运行对应技术栈的真实服务端代码，不会用 Node mock 代替业务服务；交互清单中的数据动作必须能由 OpenAPI 契约和真实持久化行为支撑。",
    "原型必须可离线打开，不使用 CDN、远程字体或远程图片；使用真实中文产品文案，覆盖主流程和关键 loading/empty/error/success 状态，具备键盘焦点与 reduced-motion 处理。",
    "这是供用户确认的设计基线，不是最终生产实现：不要写入 src/d2c-output，不要调用 D2cCompare。interaction-manifest.json 必须描述可执行的页面场景、稳定 selector、点击/输入/断言步骤。",
    "interaction-manifest 必须按完整用户旅程设计，而不是随机抽查控件：列表/查询类覆盖输入条件 → 点击查询 → 结果断言 → 重置 → 恢复断言 → 分页切换；表单类覆盖打开入口 → 必填校验 → 完整输入 → 提交 → 成功或失败反馈 → 关闭恢复；大屏类覆盖筛选联动、下钻、悬停详情、时间范围和刷新；导航必须实际打开适用的一级、二级、三级菜单并验证落点。没有某类能力时不要臆造。",
    "每次点击后必须紧跟可观察的 DOM、URL、数据或请求结果断言；输入查询条件后必须触发真实查询动作，不能只依赖 input 事件；重置、取消、返回、上一页/下一页等恢复路径也必须验收。每条场景应体现业务意图，避免把互不相关的控件动作拼在一起。",
    "所有依赖业务数据的页面都必须包含正向数据断言：至少验证一条符合 PRD 示例的真实记录或非零统计值在页面可见。不能只检查 API 请求发生、容器存在或空状态；同时保留筛选无结果时的空状态场景。",
    interactionManifestSchemaGuide(),
    `已确定技术方案为前端 ${technology.frontend}、服务端 ${technology.backend}，但设计原型保持自包含 HTML。完成后汇报主要视觉方向、交互路径和文件。`,
    `已确认 PRD 摘要（用于防止上下文漂移）：\n${prdMarkdown.slice(0, 20_000)}`,
  ].join("\n");
}
