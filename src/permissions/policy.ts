import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";

import type { PermissionDecision, PermissionRequest } from "./engine.js";

const DecisionSchema = z.enum(["allow", "ask", "deny"]);
const PrefixSchema = z.array(z.string().min(1).max(1_024)).min(1).max(64);
const RuleSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
  decision: DecisionSchema,
  prefix: PrefixSchema,
  tool: z.string().min(1).max(256).optional(),
  agent: z.enum(["main", "subagent"]).optional(),
  justification: z.string().min(1).max(2_048).optional(),
  match: z.array(PrefixSchema).max(100).optional(),
  notMatch: z.array(PrefixSchema).max(100).optional(),
}).strict();
const PolicyFileSchema = z.object({ version: z.literal(1), rules: z.array(RuleSchema).max(10_000) }).strict();

export type PermissionRule = z.infer<typeof RuleSchema> & {
  source: string;
  tier: "managed" | "user" | "project" | "local" | "session";
};

export interface PermissionPolicyLoadOptions {
  workspace: string;
  home: string;
  managedPath?: string;
  sessionRules?: readonly z.input<typeof RuleSchema>[];
}

export class CompiledPermissionPolicy {
  readonly #rules: readonly PermissionRule[];
  readonly diagnostics: readonly string[];

  constructor(rules: readonly PermissionRule[], diagnostics: readonly string[] = []) {
    this.#rules = [...rules];
    this.diagnostics = [...diagnostics];
  }

  get rules(): readonly PermissionRule[] { return this.#rules.map((rule) => ({ ...rule, prefix: [...rule.prefix] })); }

  decide(request: PermissionRequest): PermissionDecision | undefined {
    const tokens = requestTokens(request);
    const matches = this.#rules.filter((rule) =>
      (rule.tool === undefined || same(rule.tool, request.tool))
      && (rule.agent === undefined || rule.agent === request.agent)
      && prefixMatches(rule.prefix, tokens));
    if (matches.length === 0) return undefined;
    const strictest = matches.reduce((selected, candidate) => rank(candidate.decision) > rank(selected.decision) ? candidate : selected);
    const reason = strictest.justification ?? `Permission rule ${strictest.id} from ${strictest.tier} policy`;
    return { decision: strictest.decision, reason };
  }
}

export async function loadPermissionPolicy(options: PermissionPolicyLoadOptions): Promise<CompiledPermissionPolicy> {
  const sources: Array<{ tier: PermissionRule["tier"]; path: string }> = [
    ...(options.managedPath === undefined ? [] : [{ tier: "managed" as const, path: resolve(options.managedPath) }]),
    { tier: "user", path: join(resolve(options.home), ".flavor-code", "permissions.json") },
    { tier: "project", path: join(resolve(options.workspace), ".flavor", "permissions.json") },
    { tier: "local", path: join(resolve(options.workspace), ".flavor", "permissions.local.json") },
  ];
  const rules: PermissionRule[] = [];
  for (const source of sources) {
    let raw: string;
    try { raw = await readFile(source.path, "utf8"); }
    catch (error) {
      if (isCode(error, "ENOENT")) continue;
      throw error;
    }
    let parsed: z.infer<typeof PolicyFileSchema>;
    try { parsed = PolicyFileSchema.parse(JSON.parse(raw) as unknown); }
    catch (error) { throw new Error(`Invalid ${source.tier} permission policy ${source.path}: ${errorMessage(error)}`); }
    for (const input of parsed.rules) {
      validateExamples(input, source.path);
      rules.push({ ...input, source: source.path, tier: source.tier });
    }
  }
  for (const input of options.sessionRules ?? []) {
    const rule = RuleSchema.parse(input);
    validateExamples(rule, "session");
    rules.push({ ...rule, source: "session", tier: "session" });
  }
  const ids = new Set<string>();
  for (const rule of rules) {
    if (ids.has(rule.id)) throw new Error(`Duplicate permission rule id: ${rule.id}`);
    ids.add(rule.id);
  }
  return new CompiledPermissionPolicy(rules, shadowDiagnostics(rules));
}

function validateExamples(rule: z.infer<typeof RuleSchema>, source: string): void {
  for (const example of rule.match ?? []) {
    if (!prefixMatches(rule.prefix, example)) throw new Error(`Permission rule ${rule.id} in ${source} failed a match example`);
  }
  for (const example of rule.notMatch ?? []) {
    if (prefixMatches(rule.prefix, example)) throw new Error(`Permission rule ${rule.id} in ${source} failed a notMatch example`);
  }
}

function shadowDiagnostics(rules: readonly PermissionRule[]): string[] {
  const diagnostics: string[] = [];
  for (let index = 0; index < rules.length; index += 1) {
    const rule = rules[index]!;
    const shadow = rules.slice(0, index).find((candidate) =>
      sameScope(candidate, rule)
      && prefixMatches(candidate.prefix, rule.prefix)
      && rank(candidate.decision) >= rank(rule.decision));
    if (shadow !== undefined) diagnostics.push(`Permission rule ${rule.id} is shadowed by ${shadow.id}`);
  }
  return diagnostics;
}

function sameScope(left: PermissionRule, right: PermissionRule): boolean {
  return (left.tool === undefined || right.tool === undefined || same(left.tool, right.tool))
    && (left.agent === undefined || right.agent === undefined || left.agent === right.agent);
}

function requestTokens(request: PermissionRequest): string[] {
  if (request.command === undefined) return [request.tool];
  if (request.args !== undefined && request.args.length > 0) return [request.command, ...request.args];
  return splitCommand(request.command);
}

function splitCommand(command: string): string[] {
  const result: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  for (const character of command.trim()) {
    if ((character === "'" || character === '"')) {
      if (quote === character) quote = undefined;
      else if (quote === undefined) quote = character;
      else current += character;
    } else if (/\s/.test(character) && quote === undefined) {
      if (current.length > 0) { result.push(current); current = ""; }
    } else current += character;
  }
  if (current.length > 0) result.push(current);
  return result;
}

function prefixMatches(prefix: readonly string[], input: readonly string[]): boolean {
  return prefix.length <= input.length && prefix.every((token, index) => same(token, input[index] ?? ""));
}

function same(left: string, right: string): boolean {
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function rank(decision: PermissionDecision["decision"]): number {
  return decision === "deny" ? 2 : decision === "ask" ? 1 : 0;
}

function isCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code;
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
