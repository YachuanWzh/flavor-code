import { createHash } from "node:crypto";
import { join } from "node:path";

import { z } from "zod";

import { readRecoverableFile, updateProtectedFile } from "../config/protected-file.js";
import { D2C_TASK_PATTERN, taskDir } from "../d2c/store.js";

export const DELIVERY_NODE_IDS = ["requirement", "prd", "design", "d2c", "api", "acceptance", "delivery"] as const;
export type DeliveryNodeId = typeof DELIVERY_NODE_IDS[number];
export type DeliveryNodeStatus = "pending" | "running" | "waiting-approval" | "succeeded" | "failed" | "stale";

export interface DeliveryArtifactRef {
  path: string;
  hash: string;
  bytes: number;
  createdAt: string;
}

export interface DeliveryNodeRun {
  id: DeliveryNodeId;
  status: DeliveryNodeStatus;
  attempt: number;
  inputs: DeliveryArtifactRef[];
  outputs: DeliveryArtifactRef[];
  startedAt?: string;
  completedAt?: string;
  error?: string;
}

export interface E2eDeliveryRun {
  schema: 1;
  task: string;
  revision: number;
  nodes: Record<DeliveryNodeId, DeliveryNodeRun>;
  createdAt: string;
  updatedAt: string;
}

const ArtifactSchema = z.object({
  path: z.string().min(1).max(32_768), hash: z.string().regex(/^[a-f0-9]{64}$/),
  bytes: z.number().int().nonnegative(), createdAt: z.iso.datetime(),
}).strict();
const NodeSchema = z.object({
  id: z.enum(DELIVERY_NODE_IDS), status: z.enum(["pending", "running", "waiting-approval", "succeeded", "failed", "stale"]),
  attempt: z.number().int().nonnegative(), inputs: z.array(ArtifactSchema).max(10_000), outputs: z.array(ArtifactSchema).max(10_000),
  startedAt: z.iso.datetime().optional(), completedAt: z.iso.datetime().optional(), error: z.string().max(20_000).optional(),
}).strict();
const DeliveryRunSchema = z.object({
  schema: z.literal(1), task: z.string().regex(D2C_TASK_PATTERN), revision: z.number().int().nonnegative(),
  nodes: z.record(z.enum(DELIVERY_NODE_IDS), NodeSchema), createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(),
}).strict();

const dependencies: Record<DeliveryNodeId, readonly DeliveryNodeId[]> = {
  requirement: [], prd: ["requirement"], design: ["prd"], d2c: ["design"],
  api: ["d2c"], acceptance: ["api"], delivery: ["acceptance"],
};

export function artifactRef(path: string, content: string | Uint8Array, now = new Date()): DeliveryArtifactRef {
  const bytes = typeof content === "string" ? Buffer.from(content, "utf8") : Buffer.from(content);
  return { path, hash: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.byteLength, createdAt: now.toISOString() };
}

function emptyNode(id: DeliveryNodeId): DeliveryNodeRun {
  return { id, status: "pending", attempt: 0, inputs: [], outputs: [] };
}

export function createDeliveryRun(task: string, requirement: DeliveryArtifactRef, now = new Date()): E2eDeliveryRun {
  if (!D2C_TASK_PATTERN.test(task)) throw new Error("Invalid E2E delivery task name");
  const timestamp = now.toISOString();
  const nodes = Object.fromEntries(DELIVERY_NODE_IDS.map((id) => [id, emptyNode(id)])) as Record<DeliveryNodeId, DeliveryNodeRun>;
  nodes.requirement = { id: "requirement", status: "succeeded", attempt: 1, inputs: [], outputs: [requirement],
    startedAt: timestamp, completedAt: timestamp };
  return { schema: 1, task, revision: 0, nodes, createdAt: timestamp, updatedAt: timestamp };
}

export function beginDeliveryNode(
  run: E2eDeliveryRun,
  node: DeliveryNodeId,
  inputs: readonly DeliveryArtifactRef[],
  now = new Date(),
): E2eDeliveryRun {
  for (const dependency of dependencies[node]) {
    if (run.nodes[dependency].status !== "succeeded") {
      throw new Error(`Delivery node dependency ${dependency} must succeed before ${node}`);
    }
  }
  const current = run.nodes[node];
  const timestamp = now.toISOString();
  return {
    ...run,
    nodes: { ...run.nodes, [node]: { ...current, status: "running", attempt: current.attempt + 1,
      inputs: [...inputs], startedAt: timestamp, completedAt: undefined, error: undefined } },
    updatedAt: timestamp,
  };
}

function artifactSignature(artifacts: readonly DeliveryArtifactRef[]): string {
  return artifacts.map((item) => `${item.path}:${item.hash}`).sort().join("|");
}

function downstreamOf(node: DeliveryNodeId): Set<DeliveryNodeId> {
  const found = new Set<DeliveryNodeId>();
  let frontier: DeliveryNodeId[] = [node];
  while (frontier.length > 0) {
    const parents = new Set(frontier);
    frontier = DELIVERY_NODE_IDS.filter((candidate) => !found.has(candidate)
      && dependencies[candidate].some((dependency) => parents.has(dependency)));
    for (const candidate of frontier) found.add(candidate);
  }
  return found;
}

export function completeDeliveryNode(
  run: E2eDeliveryRun,
  node: DeliveryNodeId,
  outputs: readonly DeliveryArtifactRef[],
  now = new Date(),
): E2eDeliveryRun {
  const current = run.nodes[node];
  if (current.status !== "running") throw new Error(`Delivery node ${node} is not running`);
  const timestamp = now.toISOString();
  const changed = current.outputs.length > 0 && artifactSignature(current.outputs) !== artifactSignature(outputs);
  const nodes = { ...run.nodes, [node]: { ...current, status: "succeeded" as const,
    outputs: [...outputs], completedAt: timestamp, error: undefined } };
  if (changed) {
    for (const downstream of downstreamOf(node)) {
      const value = nodes[downstream];
      if (value.status !== "pending") {
        const { error: _error, ...withoutError } = value;
        nodes[downstream] = { ...withoutError, status: "stale" };
      }
    }
  }
  return { ...run, nodes, updatedAt: timestamp };
}

function deliveryRunPath(workspace: string, task: string): string {
  return join(taskDir(workspace, task), "delivery-run.json");
}

function decodeDeliveryRun(raw: string): E2eDeliveryRun {
  return DeliveryRunSchema.parse(JSON.parse(raw)) as E2eDeliveryRun;
}

function encodeDeliveryRun(run: E2eDeliveryRun): string {
  return `${JSON.stringify(DeliveryRunSchema.parse(run), null, 2)}\n`;
}

export async function initializeDeliveryRun(workspace: string, run: E2eDeliveryRun): Promise<E2eDeliveryRun> {
  return updateProtectedFile({
    path: deliveryRunPath(workspace, run.task), decode: decodeDeliveryRun, encode: encodeDeliveryRun,
    update: (current) => {
      if (current !== undefined) throw new Error(`E2E delivery run already exists: ${run.task}`);
      return run;
    },
  });
}

export async function readDeliveryRun(workspace: string, task: string): Promise<E2eDeliveryRun | undefined> {
  return (await readRecoverableFile(deliveryRunPath(workspace, task), decodeDeliveryRun))?.value;
}

export async function updateDeliveryRun(
  workspace: string,
  task: string,
  expectedRevision: number,
  mutation: (current: E2eDeliveryRun) => E2eDeliveryRun,
): Promise<E2eDeliveryRun> {
  return updateProtectedFile({
    path: deliveryRunPath(workspace, task), decode: decodeDeliveryRun, encode: encodeDeliveryRun,
    update: (current) => {
      if (current === undefined) throw new Error(`E2E delivery run is unavailable: ${task}`);
      if (current.revision !== expectedRevision) {
        throw new Error(`STALE_REVISION: expected ${expectedRevision}, current ${current.revision}`);
      }
      const next = mutation(current);
      if (next.task !== current.task || next.schema !== current.schema) throw new Error("Delivery run identity cannot change");
      return { ...next, revision: current.revision + 1, updatedAt: new Date().toISOString() };
    },
  });
}
