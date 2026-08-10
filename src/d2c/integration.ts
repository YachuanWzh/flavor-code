import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { D2cApiMapping, D2cApiOperation, D2cOpenApiDocument } from "./openapi.js";

type JsonRecord = Record<string, unknown>;
function record(value: unknown): JsonRecord | undefined { return typeof value === "object" && value !== null && !Array.isArray(value) ? value as JsonRecord : undefined; }

export function sampleForSchema(raw: unknown): unknown {
  const schema = record(raw);
  if (schema === undefined) return null;
  if (schema.example !== undefined) return schema.example;
  if (schema.default !== undefined) return schema.default;
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0];
  const type = typeof schema.type === "string" ? schema.type : schema.properties !== undefined ? "object" : "unknown";
  if (type === "object") return Object.fromEntries(Object.entries(record(schema.properties) ?? {}).map(([key, value]) => [key, sampleForSchema(value)]));
  if (type === "array") return [sampleForSchema(schema.items)];
  if (type === "integer" || type === "number") return 1;
  if (type === "boolean") return true;
  if (type === "string") return schema.format === "date-time" ? "2026-08-10T00:00:00.000Z"
    : schema.format === "date" ? "2026-08-10" : schema.format === "uri" ? "https://example.com/image.png" : "string";
  return null;
}

function identifier(value: string): string {
  const clean = value.replace(/[^A-Za-z0-9_$]/g, "_");
  return /^[A-Za-z_$]/.test(clean) ? clean : `operation_${clean}`;
}

function apiModule(operations: readonly D2cApiOperation[]): string {
  const names = new Map<string, number>();
  const functions = operations.map((operation) => {
    const pathParams = operation.parameters.filter((field) => field.location === "path").map((field) => field.name);
    let pathExpression = JSON.stringify(operation.path);
    for (const name of pathParams) pathExpression += `.replace(${JSON.stringify(`{${name}}`)}, encodeURIComponent(String(input.path?.[${JSON.stringify(name)}] ?? "")))`;
    const baseName = identifier(operation.operationId);
    const occurrence = (names.get(baseName) ?? 0) + 1;
    names.set(baseName, occurrence);
    const functionName = occurrence === 1 ? baseName : `${baseName}_${identifier(`${operation.method}_${operation.path}`)}`;
    return `export async function ${functionName}(input = {}) {\n`
      + `  const response = await http.request({ method: ${JSON.stringify(operation.method)}, url: ${pathExpression}, params: input.query, data: input.body, headers: input.headers });\n`
      + "  return response.data;\n}";
  });
  return `import { http } from "./http.js";\n\n${functions.join("\n\n")}\n`;
}

function mockModule(document: D2cOpenApiDocument): string {
  const routes = document.operations.map((operation) => {
    const route = operation.path.replaceAll(/\{([^}]+)\}/g, ":$1");
    const sample = operation.responseExample ?? sampleForSchema(operation.responseSchema);
    return `app.${operation.method.toLowerCase()}(${JSON.stringify(route)}, (_request, response) => response.status(${operation.statusCode}).json(${JSON.stringify(sample)}));`;
  });
  return `import express from "express";\n\nconst app = express();\napp.disable("x-powered-by");\napp.use(express.json({ limit: "1mb" }));\n`
    + "app.use((request, response, next) => { const origin = request.headers.origin || \"\"; if (/^http:\\/\\/(?:127\\.0\\.0\\.1|localhost):\\d+$/.test(origin)) response.setHeader(\"Access-Control-Allow-Origin\", origin); response.setHeader(\"Access-Control-Allow-Headers\", \"Content-Type, Authorization\"); response.setHeader(\"Access-Control-Allow-Methods\", \"GET,POST,PUT,PATCH,DELETE,OPTIONS\"); if (request.method === \"OPTIONS\") return response.sendStatus(204); next(); });\n"
    + "app.get(\"/_d2c/health\", (_request, response) => response.json({ ok: true }));\n"
    + `${routes.join("\n")}\n\nconst port = Number(process.env.D2C_MOCK_PORT || 0);\n`
    + "const server = app.listen(port, \"127.0.0.1\", () => { const address = server.address(); console.log(JSON.stringify({ type: \"d2c-mock-ready\", port: typeof address === \"object\" && address ? address.port : port })); });\n"
    + "for (const signal of [\"SIGINT\", \"SIGTERM\"]) process.on(signal, () => server.close(() => process.exit(0)));\n";
}

export async function generateIntegrationArtifacts(
  projectDir: string,
  document: D2cOpenApiDocument,
  mappings: readonly D2cApiMapping[],
): Promise<{ files: string[] }> {
  if (mappings.some((mapping) => mapping.status === "needs-confirmation")) throw new Error("Confirm every uncertain OpenAPI mapping before generating integration code");
  const packagePath = join(projectDir, "package.json");
  let pkg: JsonRecord;
  try { pkg = JSON.parse(await readFile(packagePath, "utf8")) as JsonRecord; }
  catch { throw new Error(`D2C integration requires a valid package.json at ${packagePath}`); }
  const scripts = { ...(record(pkg.scripts) ?? {}), mock: "node mock/server.mjs" };
  const dependencies = { ...(record(pkg.dependencies) ?? {}), axios: "^1.7.9", express: "^5.2.1" };
  const selected = [...new Set(mappings.map((mapping) => mapping.operationKey))]
    .map((key) => document.operations.find((operation) => operation.id === key))
    .filter((operation): operation is D2cApiOperation => operation !== undefined);
  const apiDir = join(projectDir, "src", "api");
  const mockDir = join(projectDir, "mock");
  await Promise.all([mkdir(apiDir, { recursive: true }), mkdir(mockDir, { recursive: true })]);
  const files = ["src/api/http.js", "src/api/d2c-api.js", "src/api/d2c-bindings.json", "mock/server.mjs", "package.json"];
  await Promise.all([
    writeFile(join(apiDir, "http.js"), `import axios from "axios";\n\nexport const http = axios.create({ baseURL: import.meta.env.VITE_API_BASE_URL || ${JSON.stringify(document.baseUrl ?? "")}, timeout: 15000 });\n\nhttp.interceptors.response.use((response) => response, (error) => Promise.reject({ name: "ApiError", status: error.response?.status, message: error.response?.data?.message || error.message, cause: error }));\n`),
    writeFile(join(apiDir, "d2c-api.js"), apiModule(selected)),
    writeFile(join(apiDir, "d2c-bindings.json"), `${JSON.stringify({ schema: 1, generatedAt: new Date().toISOString(), mappings }, null, 2)}\n`),
    writeFile(join(mockDir, "server.mjs"), mockModule({ ...document, operations: selected })),
    writeFile(packagePath, `${JSON.stringify({ ...pkg, scripts, dependencies }, null, 2)}\n`),
  ]);
  return { files };
}
