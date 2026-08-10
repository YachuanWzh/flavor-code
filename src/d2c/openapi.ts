export interface D2cApiField {
  name: string;
  type: string;
  required: boolean;
  location?: "path" | "query" | "header" | "cookie" | "body";
  example?: unknown;
}

export interface D2cApiOperation {
  id: string;
  method: string;
  path: string;
  operationId: string;
  summary: string;
  tags: string[];
  parameters: D2cApiField[];
  requestFields: D2cApiField[];
  responseFields: D2cApiField[];
  responseSchema?: unknown;
  responseExample?: unknown;
  statusCode: number;
}

export interface D2cOpenApiDocument {
  version: string;
  title: string;
  baseUrl?: string;
  operations: D2cApiOperation[];
}

export interface D2cModuleDefinition {
  id: string;
  label: string;
  sourceFiles: string[];
  keywords?: string[];
  dataNeeds?: string[];
  actions?: string[];
}

export interface D2cApiMappingCandidate { operationId: string; operationKey: string; score: number }
export interface D2cApiMapping {
  moduleId: string;
  moduleLabel: string;
  operationId: string;
  operationKey: string;
  confidence: number;
  status: "auto" | "needs-confirmation" | "confirmed";
  candidates: D2cApiMappingCandidate[];
  parameters: D2cApiField[];
  requestFields: D2cApiField[];
  responseFields: D2cApiField[];
}

type JsonRecord = Record<string, unknown>;
const METHODS = ["get", "post", "put", "patch", "delete", "head", "options"] as const;

function record(value: unknown): JsonRecord | undefined { return typeof value === "object" && value !== null && !Array.isArray(value) ? value as JsonRecord : undefined; }
function strings(value: unknown): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []; }

function pointer(root: JsonRecord, ref: string): unknown {
  if (!ref.startsWith("#/")) throw new Error(`Remote or unsupported $ref is not allowed: ${ref}`);
  let current: unknown = root;
  for (const raw of ref.slice(2).split("/")) {
    const key = raw.replaceAll("~1", "/").replaceAll("~0", "~");
    const parent = record(current);
    if (parent === undefined || !(key in parent)) throw new Error(`OpenAPI $ref does not exist: ${ref}`);
    current = parent[key];
  }
  return current;
}

function resolveSchema(root: JsonRecord, value: unknown, seen = new Set<string>()): JsonRecord | undefined {
  const schema = record(value);
  if (schema === undefined) return undefined;
  if (typeof schema.$ref !== "string") return schema;
  if (seen.has(schema.$ref)) throw new Error(`Circular OpenAPI $ref: ${schema.$ref}`);
  seen.add(schema.$ref);
  return resolveSchema(root, pointer(root, schema.$ref), seen);
}

function schemaType(schema: JsonRecord | undefined): string {
  if (schema === undefined) return "unknown";
  if (typeof schema.type === "string") return schema.type;
  if (schema.properties !== undefined) return "object";
  if (schema.allOf !== undefined) return "object";
  return "unknown";
}

function fields(root: JsonRecord, raw: unknown, location?: D2cApiField["location"], ancestors = new Set<JsonRecord>()): D2cApiField[] {
  const schema = resolveSchema(root, raw);
  if (schema === undefined) return [];
  if (ancestors.has(schema)) throw new Error("Circular OpenAPI schema composition");
  if (Array.isArray(schema.allOf)) {
    const next = new Set(ancestors); next.add(schema);
    return schema.allOf.flatMap((item) => fields(root, item, location, next));
  }
  const properties = record(schema.properties);
  if (properties === undefined) return [];
  const required = new Set(strings(schema.required));
  return Object.entries(properties).map(([name, value]) => {
    const property = resolveSchema(root, value);
    const example = property?.example ?? property?.default ?? (Array.isArray(property?.enum) ? property.enum[0] : undefined);
    return { name, type: schemaType(property), required: required.has(name), ...(location === undefined ? {} : { location }), ...(example === undefined ? {} : { example }) };
  });
}

function parameterFields(root: JsonRecord, raw: unknown): { parameters: D2cApiField[]; requestFields: D2cApiField[] } {
  const parameters: D2cApiField[] = [];
  const requestFields: D2cApiField[] = [];
  if (!Array.isArray(raw)) return { parameters, requestFields };
  for (const value of raw) {
    const item = resolveSchema(root, value);
    if (item === undefined) continue;
    const rawLocation = typeof item.in === "string" ? item.in : "query";
    const location: NonNullable<D2cApiField["location"]> = ["path", "query", "header", "cookie", "body"].includes(rawLocation)
      ? rawLocation as NonNullable<D2cApiField["location"]> : "query";
    if (location === "body") {
      requestFields.push(...fields(root, item.schema, "body"));
      continue;
    }
    if (typeof item.name !== "string") continue;
    const schema = resolveSchema(root, item.schema) ?? item;
    parameters.push({ name: item.name, type: schemaType(schema), required: item.required === true, location,
      ...((schema.example ?? item.example) === undefined ? {} : { example: schema.example ?? item.example }) });
  }
  return { parameters, requestFields };
}

function mediaSchema(root: JsonRecord, content: unknown): { schema?: unknown; example?: unknown } {
  const map = record(content);
  if (map === undefined) return {};
  const media = resolveSchema(root, map["application/json"] ?? Object.values(map)[0]);
  return media === undefined ? {} : { ...(media.schema === undefined ? {} : { schema: media.schema }), ...(media.example === undefined ? {} : { example: media.example }) };
}

function response(root: JsonRecord, responses: unknown, openapi3: boolean): { statusCode: number; schema?: unknown; example?: unknown } {
  const map = record(responses) ?? {};
  const selected = Object.keys(map).filter((key) => /^2\d\d$/.test(key)).sort()[0] ?? "200";
  const entry = resolveSchema(root, map[selected]) ?? {};
  const swaggerExamples = record(entry.examples);
  const media = openapi3 ? mediaSchema(root, entry.content) : { schema: entry.schema,
    example: swaggerExamples?.["application/json"] ?? (swaggerExamples === undefined ? entry.example : Object.values(swaggerExamples)[0]) };
  const resolved = media.schema === undefined ? undefined : resolveSchema(root, media.schema);
  return { statusCode: Number(selected), ...(resolved === undefined ? {} : { schema: resolved }), ...(media.example === undefined ? {} : { example: media.example }) };
}

function operationId(method: string, path: string, raw: unknown): string {
  const item = record(raw);
  if (typeof item?.operationId === "string" && item.operationId.trim()) return item.operationId.trim();
  const suffix = path.split(/[^A-Za-z0-9]+/).filter(Boolean).map((part) => part[0]!.toUpperCase() + part.slice(1)).join("");
  return `${method.toLowerCase()}${suffix || "Root"}`;
}

export function parseOpenApiDocument(json: string): D2cOpenApiDocument {
  if (Buffer.byteLength(json, "utf8") > 8 * 1024 * 1024) throw new Error("OpenAPI JSON exceeds 8 MiB");
  let parsed: unknown;
  try { parsed = JSON.parse(json); }
  catch { throw new Error("OpenAPI input is not valid JSON"); }
  const root = record(parsed);
  if (root === undefined) throw new Error("OpenAPI document must be a JSON object");
  const openapi3 = typeof root.openapi === "string" && /^3\.(?:0|1)(?:\.|$)/.test(root.openapi);
  const swagger2 = root.swagger === "2.0";
  if (!openapi3 && !swagger2) throw new Error("Unsupported Swagger/OpenAPI version; expected Swagger 2.0 or OpenAPI 3.x");
  const version = String(openapi3 ? root.openapi : root.swagger);
  const info = record(root.info);
  const title = typeof info?.title === "string" ? info.title : "API";
  let baseUrl: string | undefined;
  if (openapi3) {
    const server = Array.isArray(root.servers) ? record(root.servers[0]) : undefined;
    if (typeof server?.url === "string") baseUrl = server.url;
  } else if (typeof root.host === "string") {
    const scheme = strings(root.schemes)[0] ?? "https";
    baseUrl = `${scheme}://${root.host}${typeof root.basePath === "string" ? root.basePath : ""}`;
  }
  const operations: D2cApiOperation[] = [];
  for (const [path, rawPath] of Object.entries(record(root.paths) ?? {})) {
    const pathItem = resolveSchema(root, rawPath);
    if (pathItem === undefined) continue;
    for (const method of METHODS) {
      const rawOperation = pathItem[method];
      const item = resolveSchema(root, rawOperation);
      if (item === undefined) continue;
      const common = parameterFields(root, pathItem.parameters);
      const own = parameterFields(root, item.parameters);
      let requestFields = [...common.requestFields, ...own.requestFields];
      if (openapi3) {
        const requestBody = resolveSchema(root, item.requestBody);
        const requestMedia = mediaSchema(root, requestBody?.content);
        requestFields = fields(root, requestMedia.schema, "body");
      }
      const result = response(root, item.responses, openapi3);
      const id = `${method.toUpperCase()} ${path}`;
      operations.push({
        id, method: method.toUpperCase(), path, operationId: operationId(method, path, item),
        summary: typeof item.summary === "string" ? item.summary : typeof item.description === "string" ? item.description : "",
        tags: strings(item.tags), parameters: [...common.parameters, ...own.parameters], requestFields,
        responseFields: fields(root, result.schema), ...(result.schema === undefined ? {} : { responseSchema: result.schema }),
        ...(result.example === undefined ? {} : { responseExample: result.example }), statusCode: result.statusCode,
      });
    }
  }
  if (operations.length === 0) throw new Error("OpenAPI document does not contain any operations");
  return { version, title, ...(baseUrl === undefined ? {} : { baseUrl }), operations };
}

function tokens(value: string): Set<string> {
  return new Set(value.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((item) => item.length > 1));
}

function score(module: D2cModuleDefinition, operation: D2cApiOperation): number {
  const left = tokens([module.id, module.label, ...(module.keywords ?? []), ...(module.dataNeeds ?? []), ...(module.actions ?? [])].join(" "));
  const right = tokens([operation.operationId, operation.summary, operation.path, ...operation.tags, ...operation.responseFields.map((field) => field.name)].join(" "));
  if (left.size === 0) return 0;
  let overlap = 0;
  for (const token of left) if (right.has(token)) overlap += 1;
  let value = overlap / Math.max(2, left.size);
  if (right.has(module.id.toLowerCase())) value += .25;
  const actions = new Set((module.actions ?? []).map((item) => item.toLowerCase()));
  if ((actions.has("load") || actions.has("list") || actions.has("read")) && operation.method === "GET") value += .12;
  if ((actions.has("submit") || actions.has("create")) && operation.method === "POST") value += .12;
  return Math.round(Math.min(1, value) * 100) / 100;
}

export function matchModulesToOperations(modules: readonly D2cModuleDefinition[], operations: readonly D2cApiOperation[]): D2cApiMapping[] {
  if (operations.length === 0) throw new Error("Cannot match modules without OpenAPI operations");
  return modules.map((module) => {
    const ranked = operations.map((operation) => ({ operation, score: score(module, operation) }))
      .sort((a, b) => b.score - a.score || a.operation.id.localeCompare(b.operation.id));
    const best = ranked[0]!;
    const margin = best.score - (ranked[1]?.score ?? 0);
    const status: D2cApiMapping["status"] = best.score >= .45 && margin >= .1 ? "auto" : "needs-confirmation";
    return {
      moduleId: module.id, moduleLabel: module.label, operationId: best.operation.operationId, operationKey: best.operation.id,
      confidence: best.score, status,
      candidates: ranked.slice(0, 5).map((item) => ({ operationId: item.operation.operationId, operationKey: item.operation.id, score: item.score })),
      parameters: best.operation.parameters, requestFields: best.operation.requestFields, responseFields: best.operation.responseFields,
    };
  });
}

export function confirmApiMapping(mapping: D2cApiMapping, operationKey: string, operations: readonly D2cApiOperation[]): D2cApiMapping {
  const operation = operations.find((item) => item.id === operationKey);
  if (operation === undefined) throw new Error(`Unknown OpenAPI operation: ${operationKey}`);
  return { ...mapping, operationId: operation.operationId, operationKey: operation.id, status: "confirmed",
    parameters: operation.parameters, requestFields: operation.requestFields, responseFields: operation.responseFields };
}
