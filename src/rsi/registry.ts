/**
 * RSI experiment registry — task P0-04b (rsi.md 9.2, P0-04 acceptance).
 *
 * Authority is the control event log: every lineage record, reference pin,
 * stable release, and eval report is a durable event, so the registry is a
 * pure view that can be rebuilt after a crash (`new RsiExperimentRegistry`
 * over the same store sees the identical protected set). Retention rules the
 * GC must consult, expressed here once:
 * - an artifact with an unreleased reference (active session, rollback
 *   target, bound report) can never be collected;
 * - the newest `retainedStableReleases` stable releases are pinned even
 *   without references — the rollback ladder must always exist;
 * - a report is keyed by the exact candidate/baseline/suite/grader hashes it
 *   was produced against, so "a slightly different candidate" can never
 *   borrow an old passing report.
 */

import { z } from "zod";

import type { RsiControlEventRecord, RsiControlStore } from "./store.js";
import { RsiEvalReportSchema } from "./types.js";

const Hex64 = z.string().regex(/^[a-f0-9]{64}$/);

export const RSI_REFERENCE_KINDS = ["active_session", "rollback_target", "eval_report"] as const;
export type RsiReferenceKind = (typeof RSI_REFERENCE_KINDS)[number];

const LineagePayloadSchema = z.object({
  artifactHash: Hex64,
  /** null marks a root (pre-RSI or baseline) artifact. */
  parentHash: Hex64.nullable(),
  improverVersion: z.string().min(1),
  riskTier: z.enum(["R0", "R1", "R2", "R3", "R4"]),
  stateSchemaVersion: z.number().int().positive(),
  compatibilityVersions: z.array(z.number().int().positive()),
  /** False only for self-derived improvements; roots default to true. */
  compatibleWithParent: z.boolean().default(true),
}).strict();
export type RsiArtifactLineage = z.infer<typeof LineagePayloadSchema>;

const ReferencePayloadSchema = z.object({
  artifactHash: Hex64,
  refId: z.string().min(1),
  kind: z.enum(RSI_REFERENCE_KINDS),
}).strict();

const ReferenceReleasePayloadSchema = z.object({ refId: z.string().min(1) }).strict();

const StableReleasePayloadSchema = z.object({
  releaseId: z.string().min(1),
  artifactHash: Hex64,
}).strict();

export interface RsiRegistryOptions {
  store: RsiControlStore;
  /** How many newest stable releases are always kept (rollback ladder). */
  retainedStableReleases?: number;
}

export class RsiArtifactProtectedError extends Error {}
export class RsiLineageConflictError extends Error {}

export class RsiExperimentRegistry {
  readonly #store: RsiControlStore;
  readonly #retained: number;

  constructor(options: RsiRegistryOptions) {
    this.#store = options.store;
    this.#retained = options.retainedStableReleases ?? 3;
  }

  /** Register (or re-assert) an artifact's experimental lineage. */
  async registerArtifact(lineage: RsiArtifactLineage, idempotencyKey?: string): Promise<RsiArtifactLineage> {
    const parsed = LineagePayloadSchema.parse(lineage);
    const existing = await this.#derive();
    const prior = existing.lineage.get(parsed.artifactHash);
    if (prior !== undefined && LineagePayloadSchema.safeParse(prior).success) {
      const priorParsed = LineagePayloadSchema.parse(prior);
      if (JSON.stringify(priorParsed) !== JSON.stringify(parsed)) {
        throw new RsiLineageConflictError(
          `Artifact ${parsed.artifactHash} already has a different durable lineage; content-addressed identity cannot be rewritten`,
        );
      }
      return priorParsed; // idempotent re-assertion
    }
    await this.#store.appendEvent({
      type: "artifact.lineage",
      ...(idempotencyKey === undefined ? {} : { idempotencyKey: `lineage:${parsed.artifactHash}` }),
      payload: { ...parsed },
    });
    return parsed;
  }

  /** Walk parent pointers upward: [self, parent, grandparent, ...]. */
  async lineageOf(artifactHash: string): Promise<RsiArtifactLineage[]> {
    const { lineage } = await this.#derive();
    const chain: RsiArtifactLineage[] = [];
    const seen = new Set<string>();
    let cursor: string | null | undefined = artifactHash;
    while (cursor !== undefined && cursor !== null) {
      if (seen.has(cursor)) throw new RsiLineageConflictError(`Lineage cycle at ${cursor}`);
      seen.add(cursor);
      const record = lineage.get(cursor);
      if (record === undefined) break;
      const parsed = LineagePayloadSchema.safeParse(record);
      if (!parsed.success) break;
      chain.push(parsed.data);
      cursor = parsed.data.parentHash;
    }
    return chain;
  }

  async childrenOf(parentHash: string): Promise<string[]> {
    const { lineage } = await this.#derive();
    const children: string[] = [];
    for (const [hash, record] of lineage) {
      const parsed = LineagePayloadSchema.safeParse(record);
      if (parsed.success && parsed.data.parentHash === parentHash) children.push(hash);
    }
    return children.sort();
  }

  /**
   * A parent whose state schema is incompatible, or that was promoted after
   * this artifact's lineage was recorded, must never borrow this artifact's
   * reports: reports resolve by exact hash tuple, and cross-version lookups
   * are filtered through `stateSchemaVersion`.
   */
  async addReference(input: { artifactHash: string; refId: string; kind: RsiReferenceKind }): Promise<void> {
    const parsed = ReferencePayloadSchema.parse(input);
    await this.#store.appendEvent({
      type: "artifact.referenced",
      idempotencyKey: `ref:${parsed.artifactHash}:${parsed.refId}`,
      payload: { ...parsed },
    });
  }

  async releaseReference(refId: string): Promise<void> {
    await this.#store.appendEvent({
      type: "artifact.reference_released",
      idempotencyKey: `refrel:${refId}`,
      payload: { refId } satisfies z.infer<typeof ReferenceReleasePayloadSchema>,
    });
  }

  async activeReferences(artifactHash: string): Promise<string[]> {
    const { references } = await this.#derive();
    return [...references.entries()]
      .filter(([, entry]) => entry.artifactHash === artifactHash && !entry.released)
      .map(([refId]) => refId)
      .sort();
  }

  /** Pin a release as stable; the newest N stay collect-proof for rollback. */
  async registerStableRelease(input: { releaseId: string; artifactHash: string }): Promise<void> {
    const parsed = StableReleasePayloadSchema.parse(input);
    await this.#store.appendEvent({
      type: "promotion.committed",
      idempotencyKey: `stable:${parsed.releaseId}`,
      payload: { ...parsed },
    });
  }

  /** The GC question: may this artifact's bytes be deleted? */
  async assertCollectable(artifactHash: string): Promise<void> {
    const { references, stable } = await this.#derive();
    for (const entry of references.values()) {
      if (!entry.released && entry.artifactHash === artifactHash) {
        throw new RsiArtifactProtectedError(`Artifact ${artifactHash} is pinned by an active reference and cannot be collected`);
      }
    }
    const pinned = stable.slice(-this.#retained);
    if (pinned.some((release) => release.artifactHash === artifactHash)) {
      throw new RsiArtifactProtectedError(`Artifact ${artifactHash} is inside the retained stable release ladder and cannot be collected`);
    }
  }

  async isCollectable(artifactHash: string): Promise<boolean> {
    try {
      await this.#guardExists(artifactHash);
      await this.assertCollectable(artifactHash);
      return true;
    } catch (error) {
      if (error instanceof RsiArtifactProtectedError) return false;
      throw error;
    }
  }

  /** Register a report under its exact hash identity. */
  async registerReport(report: z.infer<typeof RsiEvalReportSchema>): Promise<void> {
    const parsed = RsiEvalReportSchema.parse(report);
    await this.#store.appendEvent({
      type: "eval.completed",
      idempotencyKey: `report:${parsed.reportId}`,
      payload: { report: { ...parsed } },
    });
  }

  /**
   * The only report lookup promotion may use: every one of the four hashes
   * must match, so an old report can never certify changed content.
   */
  async findReport(input: {
    reportId?: string;
    candidateHash: string;
    baselineHash: string;
    suiteHash: string;
    graderHash: string;
  }): Promise<z.infer<typeof RsiEvalReportSchema> | undefined> {
    const { reports } = await this.#derive();
    for (const record of reports) {
      if (record.candidateHash !== input.candidateHash) continue;
      if (record.baselineHash !== input.baselineHash) continue;
      if (record.suiteHash !== input.suiteHash) continue;
      if (record.graderHash !== input.graderHash) continue;
      if (input.reportId !== undefined && record.reportId !== input.reportId) continue;
      return record;
    }
    return undefined;
  }

  /** Refuse collection for artifacts the control log never heard of. */
  async #guardExists(artifactHash: string): Promise<void> {
    const { lineage, references, stable } = await this.#derive();
    const known = lineage.has(artifactHash)
      || [...references.values()].some((entry) => entry.artifactHash === artifactHash)
      || stable.some((release) => release.artifactHash === artifactHash);
    if (!known) throw new RsiArtifactProtectedError(`Artifact ${artifactHash} is unknown to the registry`);
  }

  async #derive(): Promise<DerivedRegistry> {
    const events = await this.#store.listEvents();
    return deriveRegistry(events);
  }
}

interface DerivedRegistry {
  lineage: Map<string, Record<string, unknown>>;
  references: Map<string, { artifactHash: string; released: boolean }>;
  stable: { releaseId: string; artifactHash: string }[];
  reports: z.infer<typeof RsiEvalReportSchema>[];
}

function deriveRegistry(events: readonly RsiControlEventRecord[]): DerivedRegistry {
  const lineage = new Map<string, Record<string, unknown>>();
  const references = new Map<string, { artifactHash: string; released: boolean }>();
  const stable: { releaseId: string; artifactHash: string }[] = [];
  const reports: z.infer<typeof RsiEvalReportSchema>[] = [];
  const releasedRefs = new Set<string>();
  for (const event of events) {
    switch (event.type) {
      case "artifact.lineage": {
        const parsed = LineagePayloadSchema.safeParse(event.payload);
        if (parsed.success) lineage.set(parsed.data.artifactHash, { ...parsed.data });
        break;
      }
      case "artifact.referenced": {
        const parsed = ReferencePayloadSchema.safeParse(event.payload);
        if (parsed.success) references.set(parsed.data.refId, { artifactHash: parsed.data.artifactHash, released: false });
        break;
      }
      case "artifact.reference_released": {
        const parsed = ReferenceReleasePayloadSchema.safeParse(event.payload);
        if (parsed.success) releasedRefs.add(parsed.data.refId);
        break;
      }
      case "promotion.committed": {
        const parsed = StableReleasePayloadSchema.safeParse(event.payload);
        if (parsed.success) stable.push({ releaseId: parsed.data.releaseId, artifactHash: parsed.data.artifactHash });
        break;
      }
      case "eval.completed": {
        const parsed = RsiEvalReportSchema.safeParse((event.payload as { report?: unknown }).report);
        if (parsed.success) reports.push(parsed.data);
        break;
      }
      default:
        break;
    }
  }
  for (const refId of releasedRefs) {
    const entry = references.get(refId);
    if (entry !== undefined) references.set(refId, { ...entry, released: true });
  }
  return { lineage, references, stable, reports };
}
