// GitHistory — a read-only tool that exposes commit history for the
// repository or a single file, so the agent can answer "why is this code
// like this" without improvising raw git commands.

import { z } from "zod";

import { fileHistory, isGitRepository } from "./service.js";
import type { ToolDefinition } from "../tools/types.js";

const GitHistoryInput = z.object({
  path: z.string().describe("File to inspect; omit for the whole repository history").optional(),
  limit: z.number().int().min(1).max(50).describe("Maximum number of commits to return (default 20)").optional(),
});

export type GitHistoryInput = z.infer<typeof GitHistoryInput>;

export function createGitHistoryTool(workspace: string): ToolDefinition<GitHistoryInput, string> {
  return {
    name: "GitHistory",
    description: "Show git commit history for the repository or for one file (follows renames). Use to understand when and why code changed.",
    inputSchema: GitHistoryInput,
    readOnly: true,
    paths: (input) => (input.path === undefined ? [] : [input.path]),
    summarize: (input) => input.path ?? "repository",
    renderForModel: (output) => output,
    async execute(input, signal) {
      signal.throwIfAborted();
      if (!(await isGitRepository(workspace))) throw new Error("Not a git repository");
      const limit = input.limit ?? 20;
      const entries = await fileHistory(workspace, input.path, limit);
      if (entries.length === 0) {
        return input.path === undefined
          ? "No commits found."
          : `No commits found for ${input.path} (the file may be untracked).`;
      }
      const scope = input.path === undefined ? "repository" : input.path;
      return [
        `git history for ${scope} (${entries.length} commits):`,
        ...entries.map((entry) => `${entry.hash} ${entry.date} ${entry.author}: ${entry.subject}`),
      ].join("\n");
    },
  };
}
