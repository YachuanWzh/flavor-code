import { z } from "zod";
import type { ToolDefinition } from "./types.js";

const QuestionOptionSchema = z.object({
  label: z.string().trim().min(1),
  description: z.string().trim().min(1),
});

const QuestionSchema = z.object({
  question: z.string().trim().min(1),
  header: z.string().trim().min(1),
  options: z.array(QuestionOptionSchema).min(1).max(4),
});

const AskUserQuestionInput = z.object({
  questions: z.array(QuestionSchema).min(1).max(4),
});

export type AskUserQuestionInput = z.infer<typeof AskUserQuestionInput>;
export type Question = z.infer<typeof QuestionSchema>;

export interface AskUserQuestionHandler {
  (questions: readonly Question[], signal: AbortSignal): Promise<Record<number, string>>;
}

/**
 * Extracts answers a hook-relayed UI (e.g. the Flavor Island app) returned for
 * an AskUserQuestion PermissionRequest. The decision's updatedInput carries the
 * re-shaped hook payload, whose `input.answers` is keyed by question text. The
 * result maps question index to answer; anything short of a complete non-empty
 * answer set returns undefined so the terminal prompt remains the fallback.
 */
export function hookAnswersFromUpdatedInput(
  updatedInput: unknown,
  questions: readonly Question[],
): Record<number, string> | undefined {
  if (typeof updatedInput !== "object" || updatedInput === null) return undefined;
  const input = (updatedInput as { input?: unknown }).input;
  if (typeof input !== "object" || input === null) return undefined;
  const answers = (input as { answers?: unknown }).answers;
  if (typeof answers !== "object" || answers === null) return undefined;
  const map = answers as Record<string, unknown>;
  const result: Record<number, string> = {};
  for (let index = 0; index < questions.length; index += 1) {
    const answer = map[questions[index]!.question];
    if (typeof answer !== "string" || answer.trim().length === 0) return undefined;
    result[index] = answer;
  }
  return result;
}

/**
 * A simple bridge that holds pending questions and resolves when answers arrive.
 * The UI layer polls `pending` to render the question prompts and calls `answer()`
 * when the user responds.
 */
export class QuestionBridge {
  #pending:
    | { questions: readonly Question[]; resolve: (answers: Record<number, string>) => void; reject: (reason: Error) => void }
    | undefined;
  #onChange: (() => void) | undefined;

  constructor(onChange?: () => void) {
    this.#onChange = onChange;
  }

  get pending(): readonly Question[] | undefined {
    return this.#pending?.questions;
  }

  ask(questions: readonly Question[], signal: AbortSignal): Promise<Record<number, string>> {
    if (this.#pending !== undefined) return Promise.reject(new Error("A question is already pending"));
    if (signal.aborted) return Promise.reject(signal.reason);
    return new Promise<Record<number, string>>((resolve, reject) => {
      const onAbort = () => {
        this.#pending = undefined;
        reject(signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason)));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      this.#pending = {
        questions,
        resolve: (answers) => {
          signal.removeEventListener("abort", onAbort);
          this.#pending = undefined;
          this.#onChange?.();
          resolve(answers);
        },
        reject: (error) => {
          signal.removeEventListener("abort", onAbort);
          this.#pending = undefined;
          this.#onChange?.();
          reject(error);
        },
      };
      this.#onChange?.();
    });
  }

  answer(answers: Record<number, string>): void {
    if (this.#pending === undefined) return;
    this.#pending.resolve(answers);
  }

  cancel(reason = "Question cancelled"): void {
    if (this.#pending === undefined) return;
    this.#pending.reject(new Error(reason));
  }

  dispose(): void {
    this.cancel("QuestionBridge disposed");
  }
}

export function createAskUserQuestionTool(
  handler: AskUserQuestionHandler,
): ToolDefinition<AskUserQuestionInput> {
  return {
    name: "AskUserQuestion",
    description:
      "Ask the user one or more clarifying questions to disambiguate a task before proceeding. Use this when the user's intent is unclear, when multiple valid approaches exist, or when a decision requires user preference. Each question has a header, a question body, and up to 4 agent-provided options. The UI always appends a final custom-input choice, so do not add an Other option yourself.",
    inputSchema: AskUserQuestionInput,
    paths: () => [],
    summarize: (input) => {
      const n = input.questions.length;
      const opts = input.questions.reduce((s, q) => s + q.options.length, 0);
      return n === 1
        ? `${input.questions[0]!.header} · ${opts} options`
        : `${n} questions · ${opts} options`;
    },
    execute: async (input, signal) => {
      signal.throwIfAborted();
      return handler(input.questions, signal);
    },
  };
}
