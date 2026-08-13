import { describe, expect, it } from "vitest";

import { matchModulesToOperations, parseOpenApiDocument } from "../../src/d2c/openapi.js";

const openapi = {
  openapi: "3.0.3",
  info: { title: "Dashboard API", version: "1" },
  servers: [{ url: "https://api.example.com/v1" }],
  paths: {
    "/users/{id}": { get: {
      operationId: "getUserProfile", tags: ["users"], summary: "用户资料",
      parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
      responses: { "200": { description: "ok", content: { "application/json": { schema: { $ref: "#/components/schemas/User" } } } } },
    } },
    "/metrics": { get: {
      operationId: "listDashboardMetrics", tags: ["dashboard"], summary: "统计卡片指标",
      responses: { "200": { description: "ok", content: { "application/json": { schema: {
        type: "object", properties: { total: { type: "integer", example: 42 }, trend: { type: "number" } },
      } } } } },
    } },
  },
  components: { schemas: { User: { type: "object", required: ["name"], properties: {
    name: { type: "string", example: "Ada" }, avatar: { type: "string", format: "uri" },
  } } } },
};

describe("OpenAPI normalization", () => {
  it("parses OpenAPI 3 operations, local refs and fields", () => {
    const parsed = parseOpenApiDocument(JSON.stringify(openapi));
    expect(parsed.version).toBe("3.0.3");
    expect(parsed.baseUrl).toBe("https://api.example.com/v1");
    expect(parsed.operations).toHaveLength(2);
    expect(parsed.operations[0]).toMatchObject({ method: "GET", path: "/users/{id}", operationId: "getUserProfile" });
    expect(parsed.operations[0]?.parameters).toContainEqual(expect.objectContaining({ name: "id", location: "path", required: true }));
    expect(parsed.operations[0]?.responseFields.map((field) => field.name)).toEqual(["name", "avatar"]);
  });

  it("parses Swagger 2 body and response schemas", () => {
    const parsed = parseOpenApiDocument(JSON.stringify({ swagger: "2.0", info: { title: "x", version: "1" },
      host: "localhost:3000", basePath: "/api", schemes: ["http"], definitions: {
        Login: { type: "object", required: ["email"], properties: { email: { type: "string" }, password: { type: "string" } } },
      }, paths: { "/login": { post: { operationId: "login", parameters: [{ in: "body", name: "body", schema: { $ref: "#/definitions/Login" } }],
        responses: { "200": { description: "ok", schema: { type: "object", properties: { token: { type: "string" } } } } } } } } }));
    expect(parsed.baseUrl).toBe("http://localhost:3000/api");
    expect(parsed.operations[0]?.requestFields.map((field) => field.name)).toEqual(["email", "password"]);
    expect(parsed.operations[0]?.responseFields[0]?.name).toBe("token");
  });

  it("resolves reusable parameters, request bodies and responses", () => {
    const parsed = parseOpenApiDocument(JSON.stringify({ openapi: "3.0.3", info: { title: "refs", version: "1" },
      components: {
        parameters: { Tenant: { name: "tenant", in: "header", required: true, schema: { type: "string" } } },
        requestBodies: { Search: { content: { "application/json": { schema: { type: "object", required: ["term"], properties: { term: { type: "string" } } } } } } },
        responses: { Results: { content: { "application/json": { schema: { type: "object", properties: { count: { type: "integer" } } } } } } },
      },
      paths: { "/search": { get: { operationId: "search", parameters: [{ $ref: "#/components/parameters/Tenant" }],
        requestBody: { $ref: "#/components/requestBodies/Search" }, responses: { "200": { $ref: "#/components/responses/Results" } } } } },
    }));
    expect(parsed.operations[0]?.parameters).toContainEqual(expect.objectContaining({ name: "tenant", location: "header" }));
    expect(parsed.operations[0]?.requestFields).toContainEqual(expect.objectContaining({ name: "term", required: true }));
    expect(parsed.operations[0]?.responseFields).toContainEqual(expect.objectContaining({ name: "count" }));
  });

  it("rejects allOf reference cycles instead of recursing indefinitely", () => {
    const cyclic = { openapi: "3.0.3", info: { title: "cycle", version: "1" }, components: { schemas: {
      Node: { allOf: [{ $ref: "#/components/schemas/Node" }] },
    } }, paths: { "/node": { get: { responses: { "200": { content: { "application/json": { schema: { $ref: "#/components/schemas/Node" } } } } } } } } };
    expect(() => parseOpenApiDocument(JSON.stringify(cyclic))).toThrow(/circular|cycle/i);
  });

  it("rejects malformed, unsupported and remote-reference documents", () => {
    expect(() => parseOpenApiDocument("not json")).toThrow(/json/i);
    expect(() => parseOpenApiDocument(JSON.stringify({ openapi: "2.0", paths: {} }))).toThrow(/version|openapi/i);
    const remote = structuredClone(openapi) as any;
    remote.paths["/users/{id}"].get.responses["200"].content["application/json"].schema = { $ref: "https://example.com/schema.json" };
    expect(() => parseOpenApiDocument(JSON.stringify(remote))).toThrow(/remote|\$ref/i);
  });

  it("matches modules deterministically and leaves ambiguous results for confirmation", () => {
    const document = parseOpenApiDocument(JSON.stringify(openapi));
    const mappings = matchModulesToOperations([
      { id: "stats", label: "统计卡片", sourceFiles: ["src/Stats.vue"], keywords: ["dashboard", "metrics"] },
      { id: "unknown", label: "快捷区域", sourceFiles: ["src/Quick.vue"] },
    ], document.operations);
    expect(mappings[0]).toMatchObject({ moduleId: "stats", operationId: "listDashboardMetrics", status: "auto" });
    expect(mappings[0]?.responseFields.map((field) => field.name)).toEqual(["total", "trend"]);
    expect(mappings[1]?.status).toBe("needs-confirmation");
    expect(mappings[1]?.candidates.length).toBeGreaterThan(0);
  });
});
