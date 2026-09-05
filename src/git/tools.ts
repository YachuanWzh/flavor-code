// GitHistory — a read-only tool that exposes commit history for the
// repository or a single file, so the agent can answer "why is this code
// like this" without improvising raw git commands.

import { z } from "zod";
import { isAbsolute, relative, resolve, sep } from "node:path";

import { fileHistory, isGitRepository } from "./service.js";
import type { ToolDefinition } from "../tools/types.js";

const GitHistoryInput = z.object({
  path: z.string().min(1).describe("Workspace-relative or absolute file path; omit for the whole repository history").optional(),
  limit: z.coerce.number().int().min(1).max(50).describe("Maximum number of commits to return (default 20)").optional(),
});

export type GitHistoryInput = z.infer<typeof GitHistoryInput>;

export function createGitHistoryTool(workspace: string): ToolDefinition<GitHistoryInput, string> {
  const root = resolve(workspace);
  const file = (path: string): string => {
    const absolute = resolve(root, path);
    const delta = relative(root, absolute);
    if (delta === ".." || delta.startsWith(`..${sep}`) || isAbsolute(delta)) throw new Error("GitHistory path is outside the workspace");
    return absolute;
  };
  return {
    name: "GitHistory",
    description: "Show git commit history for the repository or for one file (follows renames). Use to understand when and why code changed.",
    inputSchema: GitHistoryInput,
    readOnly: true,
    paths: (input) => (input.path === undefined ? [root] : [file(input.path)]),
    summarize: (input) => input.path ?? "repository",
    renderForModel: (output) => output,
    async execute(input, signal) {
      signal.throwIfAborted();
      const path = input.path === undefined ? undefined : relative(root, file(input.path));
      if (!(await isGitRepository(root, signal))) throw new Error("Not a git repository");
      const limit = input.limit ?? 20;
      const entries = await fileHistory(root, path, limit, signal);
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
