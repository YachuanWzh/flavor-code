import { createHash } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";

import { readRecoverableFile, updateProtectedFile } from "../config/protected-file.js";
import { memorySimilarity, normalizeForSimilarity } from "../memory/similarity.js";
import { containsSensitiveMemory, normalizeMemoryContent } from "../memory/store.js";
import type { ScoredMemoryCandidate } from "../memory/types.js";

const PreferenceSchema = z.object({
  id: z.string().regex(/^[a-f0-9]{12}$/),
  content: z.string().min(1).max(1000),
  type: z.enum(["user", "feedback"]),
  source: z.enum(["explicit", "inferred"]),
  status: z.enum(["proposed", "canary", "active", "suspended", "dropped"]),
  topicKey: z.string().max(128),
  keywords: z.array(z.string()).max(8),
  evidenceTasks: z.array(z.string()).max(128),
  exposures: z.array(z.string()).max(128),
  positiveTasks: z.array(z.string()).max(128),
  negativeTasks: z.array(z.string()).max(128),
  createdAt: z.string(),
  updatedAt: z.string(),
  reason: z.string().optional(),
}).strict();
const DocumentSchema = z.object({ version: z.literal(1), preferences: z.array(PreferenceSchema).max(200) }).strict();
export type EvolvedPreference = z.infer<typeof PreferenceSchema>;
type Document = z.infer<typeof DocumentSchema>;

const EXPLICIT_PREFERENCE = /^(?:请|麻烦)?\s*(?:以后|今后|往后|每次|始终|总是|不要再|别再|from now on|always|never|please keep)[^，,。！？.!?；;\n]{4,160}/iu;
const NEGATIVE_FEEDBACK = /(?:不对|错了|不是这样|别再|不要再|又犯|没按|不喜欢|撤销|undo|wrong|stop doing|do not do that|don't do that)/iu;
const POSITIVE_FEEDBACK = /(?:这样很好|这次很好|就按这样|正是这样|符合我的习惯|that's right|exactly right|keep doing this)/iu;
const MAX_PROMPT_PREFERENCES = 5;

/** Model-extracted preferences need matching words in a user's own message. */
function supportedByUser(content: string, messages: readonly string[]): boolean {
  return messages.some((message) => message.split(/[。！？.!?；;\n]/u).some((part) =>
    part.trim().length >= 4 && memorySimilarity(content, part) >= 0.2));
}

function idFor(type: string, content: string): string {
  return createHash("sha256").update(`${type}\0${normalizeForSimilarity(content)}`).digest("hex").slice(0, 12);
}

function addDistinct(values: readonly string[], value: string): string[] {
  return values.includes(value) ? [...values] : [...values.slice(-127), value];
}

function visible(preference: EvolvedPreference): boolean {
  return preference.status === "active" || preference.status === "canary";
}

export class PreferenceEvolution {
  readonly path: string;
  readonly #onExposure: ((taskId: string, ids: readonly string[]) => Promise<void>) | undefined;
  readonly #onFeedback: ((taskId: string, ids: readonly string[], sentiment: "positive" | "negative") => Promise<void>) | undefined;
  #lastExposure: { taskId: string; ids: string[] } | undefined;

  constructor(workspace: string, events: {
    onExposure?: (taskId: string, ids: readonly string[]) => Promise<void>;
    onFeedback?: (taskId: string, ids: readonly string[], sentiment: "positive" | "negative") => Promise<void>;
  } = {}) {
    this.path = join(workspace, ".flavor", "evolution", "preferences.json");
    this.#onExposure = events.onExposure;
    this.#onFeedback = events.onFeedback;
  }

  async list(): Promise<EvolvedPreference[]> {
    return (await readRecoverableFile(this.path, (raw) => DocumentSchema.parse(JSON.parse(raw))))?.value.preferences ?? [];
  }

  async propose(candidate: Pick<ScoredMemoryCandidate, "type" | "content" | "topicKey" | "keywords">,
    taskId: string, explicit: boolean, userMessages?: readonly string[]): Promise<{ id: string; status: EvolvedPreference["status"] } | undefined> {
    if (candidate.type !== "user" && candidate.type !== "feedback") return undefined;
    const content = normalizeMemoryContent(candidate.content);
    if (!content || content.length > 1000 || containsSensitiveMemory(content)) return undefined;
    if (!explicit && userMessages !== undefined && !supportedByUser(content, userMessages)) return undefined;
    const id = idFor(candidate.type, content);
    const now = new Date().toISOString();
    const preferences = await this.#update((entries) => {
      const previous = entries.find((entry) => entry.id === id);
      if (previous !== undefined) {
        if (previous.status === "dropped" && !explicit) return entries;
        const evidenceTasks = addDistinct(previous.evidenceTasks, taskId);
        const status = explicit ? "active" : previous.status === "proposed" && evidenceTasks.length >= 2 ? "canary" : previous.status;
        return entries.map((entry) => entry.id === id
          ? { ...entry, evidenceTasks, status, source: explicit ? "explicit" as const : entry.source, updatedAt: now }
          : entry);
      }
      if (entries.length >= 200) return entries;
      const next: EvolvedPreference = {
        id, content, type: candidate.type as "user" | "feedback", source: explicit ? "explicit" : "inferred",
        status: explicit ? "active" : "proposed", topicKey: candidate.topicKey.slice(0, 128),
        keywords: candidate.keywords.slice(0, 8), evidenceTasks: [taskId], exposures: [],
        positiveTasks: [], negativeTasks: [], createdAt: now, updatedAt: now,
      };
      // A new explicit correction supersedes an older, similar rule on the
      // same concrete topic. Generic topic keys never suppress unrelated rules.
      return [...entries.map((entry) => explicit && entry.topicKey === next.topicKey
        && !entry.topicKey.endsWith(".manual") && memorySimilarity(entry.content, content) >= 0.55
        && visible(entry) ? { ...entry, status: "suspended" as const, reason: `superseded by ${id}`, updatedAt: now } : entry), next];
    });
    const result = preferences.find((entry) => entry.id === id);
    return result === undefined ? undefined : { id, status: result.status };
  }

  /** Explicit user wording is authoritative; a model never has to infer this intent. */
  async observeExplicitPrompt(prompt: string, taskId: string): Promise<void> {
    const text = prompt.normalize("NFKC").trim();
    if (text.startsWith("/") || text.length < 8 || text.length > 300) return;
    if (/^(?:以后|今后|往后)(?:我|我们)(?:会|将|打算)/u.test(text)) return;
    const preference = text.match(EXPLICIT_PREFERENCE)?.[0]?.trim();
    if (preference === undefined) return;
    await this.propose({ type: "user", content: preference, topicKey: "user.explicit", keywords: [] }, taskId, true);
  }

  async contextForTask(prompt: string, taskId: string): Promise<string | undefined> {
    const all = await this.list();
    const withdrawn = all.filter((entry) => (entry.status === "dropped" || entry.status === "suspended")
      && entry.exposures.length > 0).slice(-5);
    const entries = all.filter(visible).map((entry) => {
      const relevance = Math.max(memorySimilarity(entry.content, prompt),
        ...entry.keywords.map((keyword) => normalizeForSimilarity(prompt).includes(normalizeForSimilarity(keyword)) ? 0.3 : 0));
      return { entry, relevance };
    }).filter(({ entry, relevance }) => entry.source === "explicit" || relevance >= 0.15)
      .sort((a, b) => (b.entry.source === "explicit" ? 1 : 0) - (a.entry.source === "explicit" ? 1 : 0) || b.relevance - a.relevance)
      .slice(0, MAX_PROMPT_PREFERENCES);
    if (entries.length === 0 && withdrawn.length === 0) {
      this.#lastExposure = undefined;
      return undefined;
    }
    const ids = entries.map(({ entry }) => entry.id);
    if (ids.length > 0) await this.#update((records) => records.map((entry) => ids.includes(entry.id)
      ? { ...entry, exposures: addDistinct(entry.exposures, taskId) } : entry));
    const newlyExposed = ids.filter((id) => !all.some((entry) => entry.id === id && entry.exposures.includes(taskId)));
    this.#lastExposure = { taskId, ids };
    if (newlyExposed.length > 0 && this.#onExposure !== undefined) {
      await this.#onExposure(taskId, newlyExposed).catch(() => undefined);
    }
    return [
      "Evolving project preferences. These are lower priority than the current user request and may be withdrawn.",
      ...entries.map(({ entry }) => `- [${entry.id}${entry.status === "canary" ? ", trial" : ""}] ${entry.content}`),
      ...withdrawn.map((entry) => `- Preference [${entry.id}] has been withdrawn. Ignore earlier copies of this preference in the conversation.`),
    ].join("\n");
  }

  /** Attribute direct feedback only when one preference was exposed or its ID is named. */
  async observeFeedback(prompt: string): Promise<string | undefined> {
    const exposure = this.#lastExposure;
    if (exposure === undefined) return undefined;
    const negative = NEGATIVE_FEEDBACK.test(prompt);
    const positive = POSITIVE_FEEDBACK.test(prompt);
    if (!negative && !positive) return undefined;
    const entries = await this.list();
    const named = exposure.ids.filter((id) => prompt.includes(id));
    const ids = named.length > 0 ? named : exposure.ids.length === 1
      ? exposure.ids.filter((id) => {
        const entry = entries.find((item) => item.id === id);
        return entry !== undefined && (/(?:这条偏好|这个习惯|按这条|this preference)/iu.test(prompt)
          || memorySimilarity(entry.content, prompt) >= 0.25);
      }) : [];
    if (ids.length === 0) return undefined;
    const now = new Date().toISOString();
    await this.#update((entries) => entries.map((entry) => {
      if (!ids.includes(entry.id)) return entry;
      const negativeTasks = negative ? addDistinct(entry.negativeTasks, exposure.taskId) : entry.negativeTasks;
      const positiveTasks = positive && !negative ? addDistinct(entry.positiveTasks, exposure.taskId) : entry.positiveTasks;
      let status = entry.status;
      let reason = entry.reason;
      if (negative) {
        status = entry.source === "inferred" ? "dropped" : "suspended";
        reason = "explicit negative feedback after exposure";
      } else if (entry.status === "canary" && entry.exposures.length >= 10 && positiveTasks.length >= 2 && negativeTasks.length === 0) {
        status = "active";
        reason = "repeated positive feedback across exposed tasks";
      }
      return { ...entry, status, reason, negativeTasks, positiveTasks, updatedAt: now };
    }));
    if (this.#onFeedback !== undefined) {
      await this.#onFeedback(exposure.taskId, ids, negative ? "negative" : "positive").catch(() => undefined);
    }
    return negative ? `Stopped learned preference ${ids.join(", ")} after your correction.` : undefined;
  }

  async drop(id: string, reason = "user requested drop"): Promise<boolean> { return this.#setStatus(id, "dropped", reason); }
  async restore(id: string): Promise<boolean> { return this.#setStatus(id, "canary", "restored for trial"); }

  async #setStatus(id: string, status: EvolvedPreference["status"], reason: string): Promise<boolean> {
    let found = false;
    await this.#update((entries) => entries.map((entry) => {
      if (entry.id !== id) return entry;
      found = true;
      return { ...entry, status, reason, updatedAt: new Date().toISOString() };
    }));
    return found;
  }

  async #update(update: (entries: EvolvedPreference[]) => EvolvedPreference[]): Promise<EvolvedPreference[]> {
    const result = await updateProtectedFile<Document>({
      path: this.path,
      decode: (raw) => DocumentSchema.parse(JSON.parse(raw)),
      encode: (value) => JSON.stringify(value, null, 2),
      update: (current) => ({ version: 1, preferences: update(current?.preferences ?? []) }),
    });
    return result.preferences;
  }
}
