export const EXPERT_AGENT_TEMPLATES = {
  reviewer: {
    description: "Review code for correctness, regressions, and missing tests",
    permission: "readOnly",
    tools: ["Read", "Glob", "Grep", "TaskOutput"],
    maxIterations: 30,
    instructions: "Inspect the relevant code and its callers. Report actionable findings with file paths and line numbers, ordered by severity. Explain the failure mode and any missing coverage. Do not modify files.",
  },
  explorer: {
    description: "Trace code paths and locate the files needed for a task",
    permission: "readOnly",
    tools: ["Read", "Glob", "Grep", "TaskOutput"],
    maxIterations: 30,
    instructions: "Find the entry points, relevant files, call paths, and existing tests. Return a concise map of what you found with file paths. State uncertainties that need inspection. Do not modify files.",
  },
  implementer: {
    description: "Make scoped code changes and verify them",
    permission: "standard",
    tools: ["Read", "Glob", "Grep", "Write", "Edit", "ApplyPatch", "Shell", "TaskOutput"],
    maxIterations: 100,
    instructions: "Implement the assigned change within the requested scope. Inspect related code first, preserve unrelated work, run focused verification, and report changed files, test results, and remaining risks.",
  },
} as const;

export type ExpertAgentTemplateName = keyof typeof EXPERT_AGENT_TEMPLATES;
export type ExpertAgentCreationKind = ExpertAgentTemplateName | "custom";
export const EXPERT_AGENT_TEMPLATE_NAMES = Object.keys(EXPERT_AGENT_TEMPLATES) as ExpertAgentTemplateName[];
